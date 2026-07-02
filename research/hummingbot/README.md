# Hummingbot ClickHouse Market Data Feed

Live OHLCV from cex-broker's ClickHouse archive for Hummingbot `MarketDataProvider`.

Parent docs: [research/README.md](../README.md) · [docs/research-backtest.md](../../docs/research-backtest.md)

## Files

| File | Purpose |
|------|---------|
| `clickhouse_candles_feed.py` | `CexBrokerClickHouseCandles` — `CandlesBase` that polls ClickHouse |
| `register_clickhouse_feed.py` | Registers connector `cex_broker_clickhouse` in `CandlesFactory` |
| `example_market_data_provider.py` | Usage snippet |
| `market_data_provider_contract.py` | Contract tests for HB integration |
| `verify_market_data_contract.py` | CLI to verify feed against live ClickHouse |

Core query logic lives in [research/python/cex_broker_research/live_candles.py](../python/cex_broker_research/live_candles.py) (no Hummingbot dependency).

## Setup

1. **Archive ingest running** — broker, archive-forwarder, ClickHouse, and archive watch:

```bash
SYMBOLS=BTC/USDT,BNB/USDT,DOGE/USDT bun run start-archive-watch
```

2. **ClickHouse env** (same as research toolkit):

```env
CLICKHOUSE_HOST=localhost
CLICKHOUSE_PORT=8123
CLICKHOUSE_DATABASE=market_data
```

3. **Register at Hummingbot startup** (from fietCexBroker repo root):

```bash
python research/hummingbot/register_clickhouse_feed.py
```

Or copy `clickhouse_candles_feed.py` into your Hummingbot tree and import/register manually.

4. **Use in strategy**:

```python
register_clickhouse_candles_feed()

df = self.market_data_provider.get_candles_df(
    connector_name="cex_broker_clickhouse",
    trading_pair="binance:BTC-USDT",
    interval="1m",
    max_records=500,
)
```

## Trading pair format

- `exchange:BASE-QUOTE` — e.g. `binance:BTC-USDT`, `bybit:ETH-USDT`
- `BASE-QUOTE` only — set `CLICKHOUSE_CANDLES_EXCHANGE=binance`

Exchange names match the `exchange` column in `market_data.candles` (lowercase CCXT id).

Symbol helpers: [research/python/cex_broker_research/symbols.py](../python/cex_broker_research/symbols.py).

## Polling

The feed polls `market_data.candles` (includes the forming bar) on an interval derived from the candle timeframe. Override with:

```env
CLICKHOUSE_CANDLES_POLL_SEC=5
```

## When to use

- Signal from archived cex-broker data while executing on another connector
- Shared candle history across multiple HB instances reading the same ClickHouse table
- Research/backtest parity with live strategy indicators on the same data lane

## Related tables

This feed reads **`market_data.candles`** only. Orderbook context lives in **`market_data.orderbook_snapshots`** (TOB + depth per sample) if you need execution/spread analysis outside Hummingbot's candle API.
