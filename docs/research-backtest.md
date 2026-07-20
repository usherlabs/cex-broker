# ClickHouse Research and Backtest (Path B)

Research and backtest on **cex-broker archived market data** stored in ClickHouse. Hummingbot strategy params can be exported from Python and applied manually; an optional ClickHouse candle feed exists for live HB indicators.

Entry point for the `research/` tree: [research/README.md](../research/README.md).

## Architecture

```text
cex-broker Subscribe (ORDERBOOK, OHLCV, TRADES, TICKER, …)
        → BrokerExecutionArchiver
        → archive-forwarder (POST /archive)
        → ClickHouse market_data.*
        ├─→ candle-viewer (browser chart)
        ├─→ Python research toolkit
        └─→ Hummingbot ClickHouse feed (optional)
```

### Tables

| Table | Stream | Use |
|-------|--------|-----|
| `market_data.candles` | OHLCV | Forming + closed; view `candles_closed` for backtests |
| `market_data.orderbook_snapshots` | ORDERBOOK | TOB + L2 depth in one row per sample |
| `market_data.cex_trades` | TRADES | Trade prints |
| `market_data.cex_ticker_events` | TICKER | Ticker snapshots |

Schema: [`schema/clickhouse/market_data.sql`](../schema/clickhouse/market_data.sql).  
Example SQL: [`schema/clickhouse/research_queries.sql`](../schema/clickhouse/research_queries.sql).

## Prerequisites

- Bun (broker, forwarder, candle viewer)
- Python 3.11+ (research toolkit)
- Docker (optional local ClickHouse stack)

Create the sandbox network once if using the compose file:

```bash
docker network create fiet-sandbox || true
```

## 1. Start ClickHouse and archive forwarder

From repo root:

```bash
docker compose -f docker/clickhouse-research.compose.yml up -d
```

Or run manually:

```bash
clickhouse-client --multiquery < schema/clickhouse/market_data.sql
CLICKHOUSE_PORT=8123 bun run start-archive-forwarder
```

Health check:

```bash
curl http://localhost:8090/health
```

Dev watcher (restarts on schema/forwarder changes):

```bash
CLICKHOUSE_PORT=8123 bun run dev:archive-forwarder
```

## 2. Start cex-broker with archive enabled

```env
CEX_BROKER_ARCHIVE_ENABLED=true
CEX_BROKER_ARCHIVE_FORWARDER_URL=http://localhost:8090/archive
CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH=./archive-loss.jsonl
CEX_BROKER_MARKET_ARCHIVE_ENABLED=true
CEX_BROKER_DEPLOYMENT_ID=local-dev
```

For production durability, `CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH` must be on persistent writable storage or a mounted volume. A container-local ephemeral path does not preserve loss records across container replacement.

If broker runs in Docker on the same compose network:

```env
CEX_BROKER_ARCHIVE_FORWARDER_URL=http://archive-forwarder:8090/archive
```

Start broker (example):

```bash
bun run start-broker --policy policy/policy.backtest.json --port 8086 --whitelistAll
```

Hot reload during broker development: `bun run start-broker-server`.

## 3. Seed market data

**Multi-stream watch** (recommended for the live chart and full archive):

```bash
SYMBOLS=BTC/USDT,BNB/USDT,DOGE/USDT bun run start-archive-watch
```

Ingests ORDERBOOK, OHLCV @ `1m`, TRADES, and TICKER per symbol.

Dev watcher:

```bash
SYMBOLS=BTC/USDT,BNB/USDT,DOGE/USDT bun run dev:archive-watch
```

**OHLCV-only** seeder:

```bash
CEX_BROKER_URL=localhost:8086 CEX=binance SYMBOL=BTC/USDT TIMEFRAME=1m \
  bun run examples/archive-ohlcv-subscribe.ts
```

Verify candles:

```sql
SELECT count()
FROM market_data.candles_closed
WHERE exchange = 'binance' AND symbol = 'BTC/USDT' AND timeframe = '1m';
```

Verify orderbook:

```sql
SELECT count(), max(event_time_ms)
FROM market_data.orderbook_snapshots
WHERE exchange = 'binance' AND symbol = 'BTC/USDT';
```

## 4. Run Python backtest

See [research/python/README.md](../research/python/README.md).

```bash
cd research/python
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

export CLICKHOUSE_HOST=localhost
export CLICKHOUSE_PORT=8123
export CLICKHOUSE_DATABASE=market_data

python examples/candle_backtest.py
```

Output: `research/python/examples/output/hummingbot_params.yaml`

## 5. Tune Hummingbot separately

Copy values from the exported YAML into your Hummingbot strategy config:

| cex-broker / ClickHouse | Hummingbot |
|-------------------------|------------|
| `BTC/USDT` (CCXT)       | `BTC-USDT` |
| `binance`               | `binance` or `binance_perpetual` |
| `timeframe = 1m`        | `candles_interval = 1m` |

Hummingbot live **execution** still uses its own exchange connector unless you wire a custom setup. ClickHouse is the research warehouse and optional shared candle lane.

Optional broker policy: [`policy/policy.backtest.json`](../policy/policy.backtest.json).

## Symbol mapping (Python)

```python
from cex_broker_research.symbols import ccxt_to_hb, hb_to_ccxt

ccxt_to_hb("BTC/USDT")  # "BTC-USDT"
hb_to_ccxt("BTC-USDT")  # "BTC/USDT"
```

## Live candle chart (browser)

See [research/candle-viewer/README.md](../research/candle-viewer/README.md).

```bash
CLICKHOUSE_PORT=8123 bun run start-candle-viewer
# or: CLICKHOUSE_PORT=8123 bun run dev:candle-viewer
```

Open [http://localhost:8091](http://localhost:8091). The UI polls `/api/candles` every 500ms (default). Higher chart timeframes (`5m`, `15m`, `1h`) are rolled up from archived `1m` bars.

Env: `CANDLE_VIEWER_PORT`, `CANDLE_VIEWER_SYMBOLS`, `CANDLE_VIEWER_TIMEFRAME`, `CANDLE_VIEWER_POLL_MS`.

## Live Hummingbot candles (ClickHouse feed)

Strategies can read **live archived OHLCV** from ClickHouse via Hummingbot's `MarketDataProvider`:

```text
cex-broker Subscribe(OHLCV) → ClickHouse market_data.candles
        → CexBrokerClickHouseCandles (poll)
        → MarketDataProvider.get_candles_df(...)
        → HB strategy / indicators
```

1. Ensure archive ingest is running (broker + forwarder + subscribe watch).
2. Register the feed at Hummingbot startup:

```bash
python research/hummingbot/register_clickhouse_feed.py
```

3. In a strategy or v2 controller:

```python
candles_df = self.market_data_provider.get_candles_df(
    connector_name="cex_broker_clickhouse",
    trading_pair="binance:BTC-USDT",
    interval="1m",
    max_records=500,
)
```

Trading pair formats:
- `binance:BTC-USDT` — explicit exchange + HB pair
- `BTC-USDT` — requires `CLICKHOUSE_CANDLES_EXCHANGE=binance`

Env: `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`, optional `CLICKHOUSE_CANDLES_POLL_SEC`.

See [research/hummingbot/README.md](../research/hummingbot/README.md).

## Out of scope

- cex-broker gRPC connector for Hummingbot execution
- Automated deployment of Hummingbot from research outputs

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No rows in `candles` | Broker archive env, forwarder `/health`, archive watch or OHLCV subscribe running |
| No rows in `orderbook_snapshots` | ORDERBOOK in archive watch; `CEX_BROKER_ORDERBOOK_INTERVAL_MS` |
| Forwarder 500 errors | ClickHouse up, schema applied, column types match row payload |
| Empty Python DataFrame | Query `candles_closed` (closed bars only), symbol/timeframe match ingest |
| Chart not updating | Hard-refresh browser; confirm `/api/candles` returns changing `brokerVersion` on forming bar |
| Broker cannot reach forwarder | `CEX_BROKER_ARCHIVE_FORWARDER_URL` host/port |
| Broker rejects archive startup | Exact `CEX_BROKER_ARCHIVE_ENABLED=true`, valid forwarder URL, and writable `CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH` |
