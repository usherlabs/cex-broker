"""Maker-side capture-core and checksum verifier for broker Parquet exports."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any, Iterable

from canonical_capture_fixture import sha256_canonical

_CAPTURE_CORE_FIELDS = {
	"source", "deployment_id", "capture_bundle_id", "exchange", "symbol",
	"trading_pair", "source_symbol", "asset_type", "feed", "provider",
	"source_mode", "source_time_ms", "received_time_ms", "raw_capture_id",
	"raw_capture_scope", "schema_version", "checksum_algorithm", "raw_checksum",
	"provenance_complete", "snapshot_id", "construction_mode", "gap_policy",
	"depth_limit", "sequence", "exact_l2_reconstruction_complete",
	"normalized_row_checksum",
}
_LEVEL_FIELDS = {
	"side", "level_index", "price", "amount", "notional", "mid_price",
	"spread_from_mid_bps",
}
_SUMMARY_FIELDS = {
	"best_bid", "best_ask", "best_bid_amount", "best_ask_amount", "mid_price",
	"spread", "spread_bps", "staleness_ms", "bid_level_count",
	"ask_level_count", "measurement_bands_bps", "bid_depth_by_band",
	"ask_depth_by_band",
}


def verify_order_book_rows(
	rows: Iterable[dict[str, Any]], row_kind: str,
) -> list[str]:
	required = _CAPTURE_CORE_FIELDS | (
		_LEVEL_FIELDS if row_kind == "levels" else _SUMMARY_FIELDS
	)
	failures: list[str] = []
	for index, row in enumerate(rows):
		missing = sorted(required - row.keys())
		if missing:
			failures.append(f"{row_kind}[{index}] missing fields: {','.join(missing)}")
			continue
		if row["feed"] != "ORDERBOOK":
			failures.append(f"{row_kind}[{index}] feed is not ORDERBOOK")
		if row["checksum_algorithm"] != "sha256-canonical-json-v1":
			failures.append(f"{row_kind}[{index}] checksum algorithm is unsupported")
		actual = sha256_canonical(row)
		if row["normalized_row_checksum"] != actual:
			failures.append(
				f"{row_kind}[{index}] checksum mismatch: "
				f"expected {row['normalized_row_checksum']}, got {actual}"
			)
	return failures


def verify_order_book_parquet(
	levels_path: str | Path, summary_path: str | Path,
) -> list[str]:
	import pyarrow.parquet as parquet

	levels = parquet.read_table(levels_path).to_pylist()
	summaries = parquet.read_table(summary_path).to_pylist()
	return [
		*verify_order_book_rows(levels, "levels"),
		*verify_order_book_rows(summaries, "summary"),
	]


if __name__ == "__main__":
	parser = argparse.ArgumentParser()
	parser.add_argument("levels")
	parser.add_argument("summary")
	args = parser.parse_args()
	errors = verify_order_book_parquet(args.levels, args.summary)
	if errors:
		raise SystemExit("\n".join(errors))
