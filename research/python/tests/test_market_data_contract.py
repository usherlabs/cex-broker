from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_HB_DIR = _REPO_ROOT / "research" / "hummingbot"


def _load_contract_module():
	sys.path.insert(0, str(_HB_DIR))
	return importlib.import_module("market_data_provider_contract")


def test_contract_lists_all_candles_methods():
	mod = _load_contract_module()
	methods = {
		method
		for group in mod.MARKET_DATA_PROVIDER_CONTRACT
		for method in group.methods
	}
	expected_candles = {
		"initialize_candles_feed",
		"initialize_candles_feed_list",
		"get_candles_feed",
		"stop_candle_feed",
		"get_candles_df",
		"get_historical_candles_df",
	}
	assert expected_candles.issubset(methods)


def test_only_candles_groups_use_clickhouse_extension():
	mod = _load_contract_module()
	for group in mod.MARKET_DATA_PROVIDER_CONTRACT:
		if group.coverage is mod.Coverage.CLICKHOUSE_CANDLES:
			assert "candle" in group.name.lower() or "historical" in group.name.lower()
		else:
			assert group.coverage is mod.Coverage.HUMMINGBOT_NATIVE


def test_clickhouse_connector_name():
	mod = _load_contract_module()
	assert mod.CONNECTOR_NAME == "cex_broker_clickhouse"


@pytest.mark.skipif(
	not importlib.util.find_spec("hummingbot"),
	reason="hummingbot not installed",
)
def test_register_clickhouse_feed_when_hummingbot_present():
	sys.path.insert(0, str(_HB_DIR))
	from register_clickhouse_feed import register_clickhouse_candles_feed
	from clickhouse_candles_feed import CONNECTOR_NAME, CexBrokerClickHouseCandles
	from hummingbot.data_feed.candles_feed.candles_factory import CandlesFactory

	register_clickhouse_candles_feed()
	assert CandlesFactory._candles_map[CONNECTOR_NAME] is CexBrokerClickHouseCandles
