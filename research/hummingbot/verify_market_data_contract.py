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


def _require(condition: bool, message: str) -> None:
	if not condition:
		raise RuntimeError(message)


def _is_connection_error(error: Exception) -> bool:
	message = str(error).lower()
	connection_markers = (
		"connection refused",
		"connection reset",
		"failed to establish",
		"name or service not known",
		"nodename nor servname provided",
		"timed out",
		"timeout",
		"network is unreachable",
		"errno 111",
		"errno 61",
		"errno 110",
	)
	return any(marker in message for marker in connection_markers)


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
	_require(exchange == "binance", f"expected exchange binance, got {exchange!r}")
	_require(symbol == "BTC/USDT", f"expected symbol BTC/USDT, got {symbol!r}")

	# Feed class + registration (requires hummingbot)
	try:
		from clickhouse_candles_feed import CexBrokerClickHouseCandles
		from register_clickhouse_feed import register_clickhouse_candles_feed

		_require(
			CexBrokerClickHouseCandles.__name__ == "CexBrokerClickHouseCandles",
			"unexpected ClickHouse candles feed class name",
		)
		from hummingbot.data_feed.candles_feed.candles_factory import CandlesFactory

		original_map = dict(CandlesFactory._candles_map)
		try:
			register_clickhouse_candles_feed()
			_require(
				CandlesFactory._candles_map[CONNECTOR_NAME] is CexBrokerClickHouseCandles,
				"CandlesFactory registration did not map connector to feed class",
			)
			print("OK: CandlesFactory registration")
		finally:
			CandlesFactory._candles_map.clear()
			CandlesFactory._candles_map.update(original_map)
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
		if _is_connection_error(error):
			print(f"SKIP: ClickHouse live poll ({error})")
			return
		raise RuntimeError(f"ClickHouse live poll failed: {error}") from error


def main() -> int:
	try:
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
	except Exception as error:  # noqa: BLE001
		print(f"FAIL: {error}", file=sys.stderr)
		return 1
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
