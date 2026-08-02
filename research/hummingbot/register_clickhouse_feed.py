#!/usr/bin/env python3
"""
Register cex-broker ClickHouse candles with Hummingbot CandlesFactory / MarketDataProvider.

Run once at Hummingbot startup (before strategies load candle feeds):

    python research/hummingbot/register_clickhouse_feed.py

Or from inside Hummingbot:

    from register_clickhouse_feed import register_clickhouse_candles_feed
    register_clickhouse_candles_feed()
"""

from __future__ import annotations

import sys
from pathlib import Path

_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _DIR.parents[1]
sys.path.insert(0, str(_REPO_ROOT / "research" / "python"))
sys.path.insert(0, str(_DIR))

from clickhouse_candles_feed import CONNECTOR_NAME, CexBrokerClickHouseCandles  # noqa: E402


def register_clickhouse_candles_feed() -> None:
	from hummingbot.data_feed.candles_feed.candles_factory import CandlesFactory

	CandlesFactory._candles_map[CONNECTOR_NAME] = CexBrokerClickHouseCandles


if __name__ == "__main__":
	register_clickhouse_candles_feed()
	print(f"Registered Hummingbot candles connector: {CONNECTOR_NAME}")
