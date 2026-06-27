"""
Hummingbot candles feed that reads live OHLCV from cex-broker ClickHouse archives.

Install: copy this file into your Hummingbot tree or add fietCexBroker/research/python
to PYTHONPATH, then run register_clickhouse_feed.py once at startup.

Usage with MarketDataProvider:
    candles_df = market_data_provider.get_candles_df(
        connector_name="cex_broker_clickhouse",
        trading_pair="binance:BTC-USDT",
        interval="1m",
        max_records=500,
    )
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path
from typing import List, Optional

import numpy as np

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PYTHON_RESEARCH = _REPO_ROOT / "research" / "python"
if str(_PYTHON_RESEARCH) not in sys.path:
	sys.path.insert(0, str(_PYTHON_RESEARCH))

from cex_broker_research.live_candles import (  # noqa: E402
	ClickHouseCandleQuery,
	default_poll_interval_seconds,
	fetch_candle_rows,
	parse_clickhouse_trading_pair,
)
from cex_broker_research.client import get_client  # noqa: E402

try:
	from hummingbot.core.network_iterator import NetworkStatus
	from hummingbot.core.utils.async_utils import safe_ensure_future
	from hummingbot.data_feed.candles_feed.candles_base import CandlesBase
	from hummingbot.logger import HummingbotLogger
except ImportError as exc:  # pragma: no cover - exercised inside Hummingbot runtime
	raise ImportError(
		"hummingbot is required for clickhouse_candles_feed; "
		"run inside a Hummingbot environment or install hummingbot",
	) from exc

CONNECTOR_NAME = "cex_broker_clickhouse"


class CexBrokerClickHouseCandles(CandlesBase):
	"""Poll ClickHouse market_data.candles instead of exchange websocket klines."""

	_logger: Optional[HummingbotLogger] = None
	_poll_task: Optional[asyncio.Task] = None

	def __init__(self, trading_pair: str, interval: str = "1m", max_records: int = 150):
		super().__init__(trading_pair, interval, max_records)
		self._exchange, self._ccxt_symbol = parse_clickhouse_trading_pair(trading_pair)
		self._poll_interval_sec = default_poll_interval_seconds(interval)

	@classmethod
	def logger(cls) -> HummingbotLogger:
		if cls._logger is None:
			cls._logger = logging.getLogger(__name__)
		return cls._logger

	@property
	def name(self) -> str:
		return f"cex_broker_clickhouse_{self._exchange}_{self._trading_pair}"

	@property
	def rest_url(self) -> str:
		return "clickhouse://candles"

	@property
	def wss_url(self) -> str:
		return ""

	@property
	def health_check_url(self) -> str:
		return self.rest_url

	@property
	def candles_url(self) -> str:
		return self.rest_url

	@property
	def candles_endpoint(self) -> str:
		return "candles"

	@property
	def candles_max_result_per_rest_request(self) -> int:
		return self.max_records

	@property
	def rate_limits(self) -> list:
		return []

	@property
	def intervals(self) -> dict:
		return dict(self.interval_to_seconds)

	def get_exchange_trading_pair(self, trading_pair: str) -> str:
		_, symbol = parse_clickhouse_trading_pair(trading_pair)
		return symbol.replace("/", "")

	async def check_network(self) -> NetworkStatus:
		await asyncio.get_event_loop().run_in_executor(None, get_client)
		return NetworkStatus.CONNECTED

	def _get_rest_candles_params(
		self,
		start_time: Optional[int] = None,
		end_time: Optional[int] = None,
		limit: Optional[int] = None,
	) -> dict:
		return {
			"exchange": self._exchange,
			"symbol": self._ccxt_symbol,
			"timeframe": self.interval,
			"limit": limit or self.max_records,
			"start_time": start_time,
			"end_time": end_time,
		}

	def _parse_rest_candles(self, data: dict, end_time: Optional[int] = None) -> List[List[float]]:
		query = ClickHouseCandleQuery(
			exchange=data["exchange"],
			symbol=data["symbol"],
			timeframe=data["timeframe"],
			max_records=int(data["limit"]),
			include_forming_bar=True,
		)
		rows = fetch_candle_rows(query)
		if end_time is not None:
			rows = [row for row in rows if row[0] <= end_time]
		start_time = data.get("start_time")
		if start_time is not None:
			rows = [row for row in rows if row[0] >= start_time]
		return rows

	async def fetch_candles(
		self,
		start_time: Optional[int] = None,
		end_time: Optional[int] = None,
		limit: Optional[int] = None,
	):
		await self.initialize_exchange_data()
		query_limit = min(limit or self.max_records, self.max_records)
		rows = await asyncio.get_event_loop().run_in_executor(
			None,
			fetch_candle_rows,
			ClickHouseCandleQuery(
				exchange=self._exchange,
				symbol=self._ccxt_symbol,
				timeframe=self.interval,
				max_records=query_limit,
				include_forming_bar=True,
			),
		)
		if start_time is not None:
			rows = [row for row in rows if row[0] >= start_time]
		if end_time is not None:
			rows = [row for row in rows if row[0] <= end_time]
		if not rows:
			return np.array([]).reshape(0, 10)
		return np.array(rows[-query_limit:]).astype(float)

	async def listen_for_subscriptions(self):
		"""Poll ClickHouse on an interval and refresh the in-memory candle deque."""
		while True:
			try:
				await self._poll_clickhouse_once()
				await self._sleep(self._poll_interval_sec)
			except asyncio.CancelledError:
				raise
			except Exception:
				self.logger().exception(
					"ClickHouse candle poll failed; retrying in 1s",
				)
				await self._sleep(1.0)

	async def _poll_clickhouse_once(self) -> None:
		rows = await asyncio.get_event_loop().run_in_executor(
			None,
			fetch_candle_rows,
			ClickHouseCandleQuery(
				exchange=self._exchange,
				symbol=self._ccxt_symbol,
				timeframe=self.interval,
				max_records=self.max_records,
				include_forming_bar=True,
			),
		)
		if not rows:
			return

		if len(self._candles) == 0:
			for row in rows:
				self._candles.append(row)
			self._ws_candle_available.set()
			if self._fill_candles_task is None:
				self._fill_candles_task = safe_ensure_future(self.fill_historical_candles())
			return

		latest_existing = int(self._candles[-1][0])
		latest_incoming = int(rows[-1][0])
		if latest_incoming > latest_existing + self.interval_in_seconds:
			self._candles.clear()
			for row in rows:
				self._candles.append(row)
			return

		for row in rows:
			timestamp = int(row[0])
			if timestamp > latest_existing:
				self._candles.append(row)
				latest_existing = timestamp
			elif timestamp == latest_existing:
				self._candles[-1] = row
