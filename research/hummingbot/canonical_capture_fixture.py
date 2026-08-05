"""Maker-side verifier for cex-broker canonical capture fixture v1."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

_CHECKSUM_FIELDS = {"normalized_row_checksum", "raw_checksum", "checksum"}



def _number(value: int | float | Decimal) -> str:
	if isinstance(value, Decimal):
		if not value.is_finite():
			raise ValueError("canonical numbers must be finite")
		if value == 0:
			return "0"
		rendered = format(value, "f")
		if "." in rendered:
			rendered = rendered.rstrip("0").rstrip(".")
		return rendered
	if isinstance(value, float):
		if not math.isfinite(value):
			raise ValueError("canonical numbers must be finite")
		if value == 0:
			return "0"
		if value.is_integer():
			return str(int(value))
		rendered = repr(value).lower()
	else:
		return str(value)
	if "e" not in rendered:
		return rendered
	return format(Decimal(rendered), "f")


def canonical_serialize(value: Any) -> str:
	if value is None:
		return "null"
	if isinstance(value, bool):
		return "true" if value else "false"
	if isinstance(value, (int, float, Decimal)):
		return _number(value)
	if isinstance(value, str):
		return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
	if isinstance(value, list):
		return "[" + ",".join(canonical_serialize(item) for item in value) + "]"
	if isinstance(value, dict):
		return "{" + ",".join(
			f"{json.dumps(key, ensure_ascii=False)}:{canonical_serialize(value[key])}"
			for key in sorted(value)
		) + "}"
	raise TypeError(f"unsupported canonical value type: {type(value).__name__}")


def _without_checksums(value: Any) -> Any:
	if isinstance(value, list):
		return [_without_checksums(item) for item in value]
	if isinstance(value, dict):
		return {
			key: _without_checksums(item)
			for key, item in value.items()
			if key not in _CHECKSUM_FIELDS
		}
	return value


def sha256_canonical(value: Any) -> str:
	encoded = canonical_serialize(_without_checksums(value)).encode("utf-8")
	return hashlib.sha256(encoded).hexdigest()


def _context(fixture: dict[str, Any], capture: dict[str, Any]) -> dict[str, Any]:
	return {
		**fixture["context"],
		"feed": capture["feed"],
		"sourceMode": capture["sourceMode"],
		**({"timeframe": capture["timeframe"]} if "timeframe" in capture else {}),
	}


def _raw(fixture: dict[str, Any], capture: dict[str, Any]) -> dict[str, Any]:
	context = _context(fixture, capture)
	# cex-broker redaction preserves object payloads and wraps root arrays so the
	# persisted evidence always has an object-shaped JSON envelope.
	redacted_payload = (
		{"items": capture["payload"]}
		if isinstance(capture["payload"], list)
		else capture["payload"]
	)
	raw_checksum = sha256_canonical(redacted_payload)
	raw_capture_id = sha256_canonical({
		"capture_bundle_id": context["captureBundleId"],
		"exchange": context["exchange"].lower(),
		"feed": context["feed"],
		"raw_capture_scope": "ccxt_normalized_object",
		"raw_payload_sha256": raw_checksum,
		"schema_version": context["schemaVersion"],
		"source_mode": context["sourceMode"],
		"source_symbol": context["symbol"],
		"source_time_ms": capture["eventTimeMs"],
	})
	return {
		"rawCaptureId": raw_capture_id,
		"rawCaptureScope": "ccxt_normalized_object",
		"rawChecksum": raw_checksum,
		"eventTimeMs": capture["eventTimeMs"],
		"receivedTimeMs": capture["receivedTimeMs"],
	}


def _core(context: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any]:
	return {
		"source": context["source"],
		"deployment_id": context["deploymentId"],
		"capture_bundle_id": context["captureBundleId"],
		"exchange": context["exchange"].lower(),
		"symbol": context["symbol"],
		"trading_pair": context["symbol"].replace("/", "-"),
		"source_symbol": context["symbol"],
		"asset_type": context["assetType"],
		"feed": context["feed"],
		"provider": context["provider"],
		"source_mode": context["sourceMode"],
		"source_time_ms": raw["eventTimeMs"],
		"received_time_ms": raw["receivedTimeMs"],
		"raw_capture_id": raw["rawCaptureId"],
		"raw_capture_scope": raw["rawCaptureScope"],
		"schema_version": context["schemaVersion"],
		"checksum_algorithm": context["checksumAlgorithm"],
		"raw_checksum": raw["rawChecksum"],
		"provenance_complete": 1,
	}


def _legacy_market_fields(raw: dict[str, Any]) -> dict[str, Any]:
	observed = datetime.fromtimestamp(
		raw["receivedTimeMs"] / 1000, tz=timezone.utc
	).isoformat(timespec="milliseconds").replace("+00:00", "Z")
	return {"broker_observed_timestamp": observed}


def _verify_capture(
	fixture: dict[str, Any],
	name: str,
	row: dict[str, Any],
	raw: dict[str, Any],
) -> list[str]:
	expected = fixture[name]["expected"]
	actual = {
		"raw_capture_id": raw["rawCaptureId"],
		"raw_checksum": raw["rawChecksum"],
		"normalized_row_checksum": sha256_canonical(row),
	}
	return [
		f"{name}.{field}: expected {expected[field]}, got {value}"
		for field, value in actual.items()
		if expected[field] != value
	]


def verify_fixture(path: str | Path) -> list[str]:
	fixture = json.loads(Path(path).read_text(encoding="utf-8"))
	failures: list[str] = []

	stream = fixture["stream"]
	stream_context = _context(fixture, stream)
	stream_raw = _raw(fixture, stream)
	stream_row = {
		**_core(stream_context, stream_raw),
		**_legacy_market_fields(stream_raw),
		"stream_type": stream_context["feed"],
		"event_time_ms": stream_raw["eventTimeMs"],
		"payload_encoding": "canonical_json_v1",
		"payload_json": canonical_serialize(stream["payload"]),
	}
	failures += _verify_capture(fixture, "stream", stream_row, stream_raw)

	for name, field_map in (
		("ticker", {
			"eventTimeMs": "event_time_ms", "last": "last", "bid": "bid",
			"ask": "ask", "high": "high", "low": "low", "open": "open",
			"close": "close", "baseVolume": "base_volume",
			"quoteVolume": "quote_volume", "change": "change",
			"percentage": "percentage",
		}),
		("trade", {
			"tradeId": "trade_id", "eventTimeMs": "event_time_ms",
			"side": "side", "price": "price", "amount": "amount",
			"cost": "cost", "takerOrMaker": "taker_or_maker",
		}),
	):
		capture = fixture[name]
		context = _context(fixture, capture)
		raw = _raw(fixture, capture)
		row = {**_core(context, raw)}
		row.update(_legacy_market_fields(raw))
		for source_field, row_field in field_map.items():
			if source_field in capture["normalized"]:
				row[row_field] = capture["normalized"][source_field]
		if name == "ticker":
			row["source_time_ms"] = capture["normalized"]["eventTimeMs"]
			row["payload_json"] = json.dumps(
				capture["payload"],
				ensure_ascii=False,
				separators=(",", ":"),
			)
		else:
			row["source_time_ms"] = capture["normalized"]["eventTimeMs"]
		failures += _verify_capture(fixture, name, row, raw)

	ohlcv = fixture["ohlcv"]
	ohlcv_context = _context(fixture, ohlcv)
	ohlcv_raw = _raw(fixture, ohlcv)
	bar = ohlcv["bar"]
	ohlcv_row = {
		**_core(ohlcv_context, ohlcv_raw),
		"source_time_ms": bar["openTimeMs"],
		"timeframe": ohlcv_context["timeframe"],
		"open_time_ms": bar["openTimeMs"],
		"open": bar["open"], "high": bar["high"], "low": bar["low"],
		"close": bar["close"], "volume": bar["volume"],
		"is_closed": 1 if ohlcv["isClosed"] else 0,
		"broker_version": ohlcv["brokerVersion"],
	}
	failures += _verify_capture(fixture, "ohlcv", ohlcv_row, ohlcv_raw)

	book = fixture["orderbook"]
	book_context = _context(fixture, book)
	book_raw = _raw(fixture, book)
	bids = [{"price": level[0], "amount": level[1]} for level in book["payload"]["bids"]]
	asks = [{"price": level[0], "amount": level[1]} for level in book["payload"]["asks"]]
	best_bid, best_ask = bids[0], asks[0]
	mid = (best_bid["price"] + best_ask["price"]) / 2
	spread = best_ask["price"] - best_bid["price"]
	snapshot_id = sha256_canonical({
		"exchange": book_context["exchange"].lower(),
		"trading_pair": book_context["symbol"].replace("/", "-"),
		"source_time_ms": book["eventTimeMs"],
		"sequence": book["payload"]["sequence"],
		"depth_limit": book["depthLimit"],
		"bids": bids,
		"asks": asks,
		"schema_version": book_context["schemaVersion"],
	})
	common = {
		**_core(book_context, book_raw),
		"source_time_ms": book["eventTimeMs"],
		"received_time_ms": book["receivedTimeMs"],
		"snapshot_id": snapshot_id,
		"construction_mode": "sampled_top_n_snapshot",
		"gap_policy": "record_gap",
		"depth_limit": book["depthLimit"],
		"sequence": book["payload"]["sequence"],
		"exact_l2_reconstruction_complete": 0,
	}
	first_level = {
		**common, "side": "bid", "level_index": 0,
		"price": best_bid["price"], "amount": best_bid["amount"],
		"notional": best_bid["price"] * best_bid["amount"],
		"mid_price": mid,
		"spread_from_mid_bps": abs((best_bid["price"] - mid) / mid) * 10_000,
	}
	bands = [10, 25, 50, 100]
	summary = {
		**common,
		"best_bid": best_bid["price"], "best_ask": best_ask["price"],
		"best_bid_amount": best_bid["amount"], "best_ask_amount": best_ask["amount"],
		"mid_price": mid, "spread": spread, "spread_bps": spread / mid * 10_000,
		"staleness_ms": book["receivedTimeMs"] - book["eventTimeMs"],
		"bid_level_count": len(bids), "ask_level_count": len(asks),
		"measurement_bands_bps": bands,
		"bid_depth_by_band": [
			sum(level["amount"] for level in bids if level["price"] >= best_bid["price"] * (1 - band / 10_000))
			for band in bands
		],
		"ask_depth_by_band": [
			sum(level["amount"] for level in asks if level["price"] <= best_ask["price"] * (1 + band / 10_000))
			for band in bands
		],
	}
	expected = book["expected"]
	actual_book = {
		"raw_capture_id": book_raw["rawCaptureId"],
		"raw_checksum": book_raw["rawChecksum"],
		"snapshot_id": snapshot_id,
		"level_normalized_row_checksum": sha256_canonical(first_level),
		"summary_normalized_row_checksum": sha256_canonical(summary),
	}
	failures += [
		f"orderbook.{field}: expected {expected[field]}, got {value}"
		for field, value in actual_book.items()
		if expected[field] != value
	]
	return failures
