from __future__ import annotations

import os
import re
from dataclasses import dataclass

import pandas as pd

from cex_broker_research.client import get_client
from cex_broker_research.symbols import hb_to_ccxt

# Hummingbot CandlesBase column layout (seconds timestamp + OHLCV + placeholders).
HB_CANDLE_COLUMNS = [
	"timestamp",
	"open",
	"high",
	"low",
	"close",
	"volume",
	"quote_asset_volume",
	"n_trades",
	"taker_buy_base_volume",
	"taker_buy_quote_volume",
]

_TRADING_PAIR_PATTERN = re.compile(
	r"^(?:(?P<exchange>[a-z0-9_]+):)?(?P<pair>[A-Za-z0-9]+-[A-Za-z0-9]+)$",
)


@dataclass(frozen=True)
class ClickHouseCandleQuery:
	exchange: str
	symbol: str
	timeframe: str
	max_records: int
	include_forming_bar: bool = True
	start_time_ms: int | None = None
	end_time_ms: int | None = None


def parse_clickhouse_trading_pair(
	trading_pair: str,
	default_exchange: str | None = None,
) -> tuple[str, str]:
	"""
	Parse HB trading pair for ClickHouse archive feeds.

	Formats:
	  - ``binance:BTC-USDT`` (exchange + HB pair)
	  - ``BTC-USDT`` (requires default_exchange or CLICKHOUSE_CANDLES_EXCHANGE env)
	"""
	match = _TRADING_PAIR_PATTERN.match(trading_pair.strip())
	if not match:
		raise ValueError(
			f"Invalid ClickHouse trading pair {trading_pair!r}; "
			"expected 'exchange:BASE-QUOTE' or 'BASE-QUOTE'",
		)
	exchange = match.group("exchange")
	if not exchange:
		exchange = (
			default_exchange
			or os.environ.get("CLICKHOUSE_CANDLES_EXCHANGE", "").strip()
			or os.environ.get("CEX_BROKER_HB_CLICKHOUSE_EXCHANGE", "").strip()
		)
	if not exchange:
		raise ValueError(
			f"Trading pair {trading_pair!r} has no exchange prefix; "
			"set CLICKHOUSE_CANDLES_EXCHANGE or use 'binance:BTC-USDT'",
		)
	return exchange.lower(), hb_to_ccxt(match.group("pair"))


def dataframe_to_hb_candle_rows(frame: pd.DataFrame) -> list[list[float]]:
	if frame.empty:
		return []
	rows: list[list[float]] = []
	for record in frame.itertuples(index=False):
		timestamp_sec = int(record.open_time_ms // 1000)
		raw_quote_volume = record.quote_volume
		quote_volume = (
			float(raw_quote_volume)
			if raw_quote_volume is not None and raw_quote_volume == raw_quote_volume
			else 0.0
		)
		rows.append(
			[
				float(timestamp_sec),
				float(record.open),
				float(record.high),
				float(record.low),
				float(record.close),
				float(record.volume),
				quote_volume,
				0.0,
				0.0,
				0.0,
			],
		)
	return rows


def fetch_candle_dataframe(query: ClickHouseCandleQuery) -> pd.DataFrame:
	"""Load the latest OHLCV window from ClickHouse (closed + optional forming bar)."""
	source_table = "candles" if query.include_forming_bar else "candles_closed"
	time_filters: list[str] = []
	parameters: dict[str, object] = {
		"exchange": query.exchange.lower(),
		"symbol": query.symbol,
		"timeframe": query.timeframe,
		"limit": query.max_records,
	}
	if query.start_time_ms is not None:
		time_filters.append("open_time_ms >= %(start_time_ms)s")
		parameters["start_time_ms"] = query.start_time_ms
	if query.end_time_ms is not None:
		time_filters.append("open_time_ms <= %(end_time_ms)s")
		parameters["end_time_ms"] = query.end_time_ms
	time_clause = f"\n\t\t\tAND {' AND '.join(time_filters)}" if time_filters else ""
	sql = f"""
		SELECT
			open_time_ms,
			open,
			high,
			low,
			close,
			volume,
			quote_volume,
			is_closed,
			broker_version
		FROM {source_table}
		WHERE exchange = %(exchange)s
			AND symbol = %(symbol)s
			AND timeframe = %(timeframe)s{time_clause}
		ORDER BY open_time_ms DESC
		LIMIT %(limit)s
	"""
	client = get_client()
	frame = client.query_df(
		sql,
		parameters=parameters,
	)
	if frame.empty:
		return frame
	for col in ("open", "high", "low", "close", "volume", "quote_volume"):
		if col in frame.columns:
			frame[col] = pd.to_numeric(frame[col], errors="coerce")
	frame.sort_values("open_time_ms", inplace=True)
	frame.reset_index(drop=True, inplace=True)
	return frame


def fetch_candle_rows(query: ClickHouseCandleQuery) -> list[list[float]]:
	return dataframe_to_hb_candle_rows(fetch_candle_dataframe(query))


def default_poll_interval_seconds(interval: str) -> float:
	"""Poll interval derived from candle timeframe (override via CLICKHOUSE_CANDLES_POLL_SEC)."""
	override = os.environ.get("CLICKHOUSE_CANDLES_POLL_SEC", "").strip()
	if override:
		return max(float(override), 0.5)
	interval_seconds = {
		"1s": 1,
		"1m": 60,
		"3m": 180,
		"5m": 300,
		"15m": 900,
		"30m": 1800,
		"1h": 3600,
		"2h": 7200,
		"4h": 14400,
		"6h": 21600,
		"8h": 28800,
		"12h": 43200,
		"1d": 86400,
		"3d": 259200,
		"1w": 604800,
		"1M": 2592000,
	}.get(interval, 60)
	return max(min(interval_seconds / 2.0, 15.0), 1.0)
