from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_HUMMINGBOT = _REPO_ROOT / "research" / "hummingbot"
sys.path.insert(0, str(_HUMMINGBOT))

from canonical_capture_fixture import (  # noqa: E402
	canonical_serialize,
	sha256_canonical,
	verify_fixture,
)
from order_book_parquet_fixture import verify_order_book_parquet  # noqa: E402


def test_python_reproduces_typescript_golden_capture_checksums():
	fixture = _REPO_ROOT / "test" / "fixtures" / "canonical-market-capture-v1.json"
	assert verify_fixture(fixture) == []


def test_python_canonical_number_and_key_representation():
	assert canonical_serialize({"z": -0.0, "a": 1e-7}) == '{"a":0.0000001,"z":0}'
	assert canonical_serialize(Decimal("100.000000000000000000")) == "100"


def test_maker_parquet_reader_preserves_capture_core_and_checksums(tmp_path):
	import pyarrow as pa
	import pyarrow.parquet as parquet

	common = {
		"source": "broker_read", "deployment_id": "test", "capture_bundle_id": "bundle",
		"exchange": "binance", "symbol": "BTC/USDT", "trading_pair": "BTC-USDT",
		"source_symbol": "BTC/USDT", "asset_type": "spot", "feed": "ORDERBOOK",
		"provider": "ccxt:binance", "source_mode": "broker_live_sampling_v1",
		"source_time_ms": 1_700_000_000_000, "received_time_ms": 1_700_000_000_010,
		"raw_capture_id": "raw-id", "raw_capture_scope": "ccxt_normalized_object",
		"schema_version": "1.0.0", "checksum_algorithm": "sha256-canonical-json-v1",
		"raw_checksum": "raw-checksum", "provenance_complete": 1,
		"snapshot_id": "snapshot-id", "construction_mode": "sampled_top_n_snapshot",
		"gap_policy": "record_gap", "depth_limit": 1, "sequence": 7,
		"exact_l2_reconstruction_complete": 0,
	}
	level = {
		**common, "side": "bid", "level_index": 0, "price": Decimal("100"),
		"amount": Decimal("2"), "notional": Decimal("200"),
		"mid_price": Decimal("100.5"), "spread_from_mid_bps": 49.75124378109453,
	}
	level["normalized_row_checksum"] = sha256_canonical(level)
	summary = {
		**common, "best_bid": Decimal("100"), "best_ask": Decimal("101"),
		"best_bid_amount": Decimal("2"), "best_ask_amount": Decimal("3"),
		"mid_price": Decimal("100.5"), "spread": Decimal("1"),
		"spread_bps": 99.50248756218906, "staleness_ms": 10,
		"bid_level_count": 1, "ask_level_count": 1,
		"measurement_bands_bps": [10, 25],
		"bid_depth_by_band": [Decimal("2"), Decimal("2")],
		"ask_depth_by_band": [Decimal("3"), Decimal("3")],
	}
	summary["normalized_row_checksum"] = sha256_canonical(summary)
	levels_path = tmp_path / "order_book_levels.parquet"
	summary_path = tmp_path / "order_book_depth_summary.parquet"
	parquet.write_table(pa.Table.from_pylist([level]), levels_path)
	parquet.write_table(pa.Table.from_pylist([summary]), summary_path)
	assert verify_order_book_parquet(levels_path, summary_path) == []
