#!/usr/bin/env python3
"""Print MarketDataProvider contract coverage and run smoke checks."""

from __future__ import annotations

import sys
from pathlib import Path

_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _DIR.parents[1]
sys.path.insert(0, str(_REPO_ROOT / "research" / "python"))
sys.path.insert(0, str(_DIR))

from market_data_provider_contract import (  # noqa: E402
	CONNECTOR_NAME,
	Coverage,
	MARKET_DATA_PROVIDER_CONTRACT,
)
from cex_broker_research.live_candles import (  # noqa: E402
	fetch_candle_rows,
	parse_clickhouse_trading_pair,
)


def print_coverage_matrix() -> None:
	print("MarketDataProvider contract coverage (cex-broker repo)\n")
	print(f"{'Group':<24} {'Coverage':<28} Methods")
	print("-" * 80)
	for group in MARKET_DATA_PROVIDER_CONTRACT:
		print(f"{group.name:<24} {group.coverage.value:<28} {len(group.methods)}")
		for method in group.methods:
			print(f"  - {method}")
		print(f"    {group.notes}\n")


def smoke_test_clickhouse_candle_path() -> None:
	exchange, symbol = parse_clickhouse_trading_pair("binance:BTC-USDT")
	assert exchange == "binance"
	assert symbol == "BTC/USDT"

	# Feed class + registration (requires hummingbot)
	try:
		from clickhouse_candles_feed import CexBrokerClickHouseCandles
		from register_clickhouse_feed import register_clickhouse_candles_feed

		assert CexBrokerClickHouseCandles.__name__ == "CexBrokerClickHouseCandles"
		register_clickhouse_candles_feed()
		from hummingbot.data_feed.candles_feed.candles_factory import CandlesFactory

		assert CandlesFactory._candles_map[CONNECTOR_NAME] is CexBrokerClickHouseCandles
		print("OK: CandlesFactory registration")
	except ImportError as error:
		if "hummingbot" not in str(error).lower():
			raise
		print("SKIP: CexBrokerClickHouseCandles / registration (hummingbot not installed)")

	# Optional live ClickHouse query
	try:
		from cex_broker_research.live_candles import ClickHouseCandleQuery

		rows = fetch_candle_rows(
			ClickHouseCandleQuery(
				exchange=exchange,
				symbol=symbol,
				timeframe="1m",
				max_records=3,
			),
		)
		print(f"OK: ClickHouse poll returned {len(rows)} candle row(s)")
	except Exception as error:  # noqa: BLE001
		print(f"SKIP: ClickHouse live poll ({error})")


def main() -> int:
	print_coverage_matrix()
	clickhouse_groups = [
		g for g in MARKET_DATA_PROVIDER_CONTRACT if g.coverage is Coverage.CLICKHOUSE_CANDLES
	]
	native_groups = [
		g for g in MARKET_DATA_PROVIDER_CONTRACT if g.coverage is Coverage.HUMMINGBOT_NATIVE
	]
	print(
		f"Summary: {len(clickhouse_groups)} group(s) extended by cex-broker ClickHouse feed, "
		f"{len(native_groups)} group(s) are Hummingbot-native (not reimplemented here).\n",
	)
	smoke_test_clickhouse_candle_path()
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
