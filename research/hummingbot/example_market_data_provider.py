"""
Example: use ClickHouse archived candles via Hummingbot MarketDataProvider.

Prerequisites:
  - cex-broker archiving OHLCV to ClickHouse (see docs/research-backtest.md)
  - CLICKHOUSE_HOST / CLICKHOUSE_PORT env vars pointing at ClickHouse HTTP
  - register_clickhouse_feed.py executed once at HB startup

In a ScriptStrategyBase or v2 controller:

    from research.hummingbot.register_clickhouse_feed import register_clickhouse_candles_feed

    register_clickhouse_candles_feed()

    # Inside on_tick or update_processed_data:
    candles_df = self.market_data_provider.get_candles_df(
        connector_name="cex_broker_clickhouse",
        trading_pair="binance:BTC-USDT",
        interval="1m",
        max_records=500,
    )

Trading pair format:
  - ``binance:BTC-USDT`` — explicit exchange + HB pair
  - ``BTC-USDT`` — requires CLICKHOUSE_CANDLES_EXCHANGE=binance

The feed polls ClickHouse (closed + forming bars) instead of exchange websockets.
Useful when execution happens on a different venue than the signal source.
"""
