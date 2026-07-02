from __future__ import annotations

import pytest

from cex_broker_research.live_candles import (
	ClickHouseCandleQuery,
	dataframe_to_hb_candle_rows,
	default_poll_interval_seconds,
	parse_clickhouse_trading_pair,
)


def test_parse_clickhouse_trading_pair_with_exchange_prefix():
	exchange, symbol = parse_clickhouse_trading_pair("binance:BTC-USDT")
	assert exchange == "binance"
	assert symbol == "BTC/USDT"


def test_parse_clickhouse_trading_pair_uses_env(monkeypatch):
	monkeypatch.setenv("CLICKHOUSE_CANDLES_EXCHANGE", "bybit")
	exchange, symbol = parse_clickhouse_trading_pair("ETH-USDT")
	assert exchange == "bybit"
	assert symbol == "ETH/USDT"


def test_parse_clickhouse_trading_pair_requires_exchange(monkeypatch):
	monkeypatch.delenv("CLICKHOUSE_CANDLES_EXCHANGE", raising=False)
	monkeypatch.delenv("CEX_BROKER_HB_CLICKHOUSE_EXCHANGE", raising=False)
	with pytest.raises(ValueError, match="no exchange prefix"):
		parse_clickhouse_trading_pair("BTC-USDT")


def test_dataframe_to_hb_candle_rows():
	class Row:
		open_time_ms: int
		open: float
		high: float
		low: float
		close: float
		volume: float
		quote_volume: float

		def __init__(self, **values: float | int):
			for key, value in values.items():
				setattr(self, key, value)

	class FakeFrame:
		empty = False

		def itertuples(self, index: bool = False):
			yield Row(
				open_time_ms=1_700_000_000_000,
				open=100,
				high=110,
				low=90,
				close=105,
				volume=12.5,
				quote_volume=1300.0,
			)

	rows = dataframe_to_hb_candle_rows(FakeFrame())  # type: ignore[arg-type]
	assert rows == [[1_700_000_000, 100, 110, 90, 105, 12.5, 1300.0, 0.0, 0.0, 0.0]]


def test_default_poll_interval_seconds_respects_override(monkeypatch):
	monkeypatch.setenv("CLICKHOUSE_CANDLES_POLL_SEC", "2.5")
	assert default_poll_interval_seconds("1m") == 2.5


def test_clickhouse_candle_query_defaults():
	query = ClickHouseCandleQuery(
		exchange="binance",
		symbol="BTC/USDT",
		timeframe="1m",
		max_records=100,
	)
	assert query.include_forming_bar is True
	assert query.start_time_ms is None
	assert query.end_time_ms is None


def test_fetch_candle_dataframe_applies_time_bounds_in_sql(monkeypatch):
	captured: dict[str, object] = {}

	class FakeClient:
		def query_df(self, sql, parameters=None):
			captured["sql"] = sql
			captured["parameters"] = parameters

			class EmptyFrame:
				empty = True

			return EmptyFrame()

	monkeypatch.setattr(
		"cex_broker_research.live_candles.get_client",
		lambda: FakeClient(),
	)
	from cex_broker_research.live_candles import fetch_candle_dataframe

	fetch_candle_dataframe(
		ClickHouseCandleQuery(
			exchange="binance",
			symbol="BTC/USDT",
			timeframe="1m",
			max_records=10,
			start_time_ms=1_000,
			end_time_ms=2_000,
		),
	)
	sql = str(captured["sql"])
	parameters = captured["parameters"]
	assert "open_time_ms >= %(start_time_ms)s" in sql
	assert "open_time_ms <= %(end_time_ms)s" in sql
	assert parameters["start_time_ms"] == 1_000  # type: ignore[index]
	assert parameters["end_time_ms"] == 2_000  # type: ignore[index]
