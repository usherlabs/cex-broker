# ClickHouse Research and Backtest (Path B)

Research and backtest on **cex-broker archived candles** stored in ClickHouse. Hummingbot is tuned **separately** from research outputs (manual copy of exported params). There is no live Hummingbot ClickHouse feed in this path.

## Architecture

```text
cex-broker Subscribe(OHLCV)
        → BrokerExecutionArchiver
        → archive-forwarder (POST /archive)
        → ClickHouse market_data.candles
        → Python research toolkit
        → research/output/hummingbot_params.yaml
        → Hummingbot (manual config)
```

## Prerequisites

- Bun (broker + forwarder)
- Python 3.11+ (research toolkit)
- Docker (optional local ClickHouse stack)

Create the sandbox network once if using the compose file with `fiet-sandbox`:

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
# ClickHouse on localhost:8123 with schema applied:
clickhouse-client --multiquery < schema/clickhouse/market_data.sql

bun run start-archive-forwarder
```

Health check:

```bash
curl http://localhost:8090/health
```

## 2. Start cex-broker with archive enabled

```env
CEX_BROKER_ARCHIVE_FORWARDER_HOST=localhost
CEX_BROKER_ARCHIVE_FORWARDER_PORT=8090
CEX_BROKER_MARKET_ARCHIVE_ENABLED=true
CEX_BROKER_DEPLOYMENT_ID=local-dev
```

If broker runs in Docker on the same compose network:

```env
CEX_BROKER_ARCHIVE_FORWARDER_URL=http://archive-forwarder:8090/archive
```

Start broker (example):

```bash
bun run start-broker --policy policy/policy.backtest.json --port 8086 --whitelistAll
```

## 3. Seed candle data

Run the OHLCV archive seeder (long-lived subscribe client):

```bash
CEX_BROKER_URL=localhost:8086 CEX=binance SYMBOL=BTC/USDT TIMEFRAME=1m \
  bun run examples/archive-ohlcv-subscribe.ts
```

Verify data in ClickHouse:

```sql
SELECT count()
FROM market_data.candles_closed
WHERE exchange = 'binance' AND symbol = 'BTC/USDT' AND timeframe = '1m';
```

See [`schema/clickhouse/research_queries.sql`](../schema/clickhouse/research_queries.sql) for rollup and freshness examples.

## 4. Run Python backtest

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

This loads closed candles, runs a simple SMA crossover backtest, and writes:

`research/python/examples/output/hummingbot_params.yaml`

## 5. Tune Hummingbot separately

Copy values from the exported YAML into your Hummingbot strategy config:

| cex-broker / ClickHouse | Hummingbot |
|-------------------------|------------|
| `BTC/USDT` (CCXT)       | `BTC-USDT` |
| `binance`               | `binance` or `binance_perpetual` |
| `timeframe = 1m`        | `candles_interval = 1m` |

Hummingbot live trading still uses its **own exchange connector** for execution and live candles. ClickHouse is the research warehouse only.

Optional broker policy for backtest environments: [`policy/policy.backtest.json`](../policy/policy.backtest.json).

## Symbol mapping (Python)

```python
from cex_broker_research.symbols import ccxt_to_hb, hb_to_ccxt

ccxt_to_hb("BTC/USDT")  # "BTC-USDT"
hb_to_ccxt("BTC-USDT")  # "BTC/USDT"
```

## Live candle chart (browser)

Real-time candlestick chart from ClickHouse (includes the forming bar):

```bash
CLICKHOUSE_PORT=18123 bun run start-candle-viewer
```

Open [http://localhost:8091](http://localhost:8091). The viewer polls `market_data.candles` and pushes updates over WebSocket (TradingView **Lightweight Charts**).

Higher timeframes (`5m`, `15m`, `1h`) are **rolled up from archived `1m` bars** in the viewer — only `1m` needs to be ingested.

Default symbols: `BTC/USDT`, `BNB/USDT`, `DOGE/USDT`. Archive watch ingests all three:

```bash
SYMBOLS=BTC/USDT,BNB/USDT,DOGE/USDT bun run start-archive-watch
```

Env overrides: `CANDLE_VIEWER_PORT`, `CANDLE_VIEWER_SYMBOLS`, `CANDLE_VIEWER_TIMEFRAME`, `CANDLE_VIEWER_POLL_MS`.

## Out of scope

- Custom Hummingbot `CandlesBase` reading ClickHouse at runtime
- cex-broker gRPC connector for Hummingbot execution
- Automated deployment of Hummingbot from research outputs

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No rows in `candles` | Broker archive env, forwarder `/health`, OHLCV subscribe running |
| Forwarder 500 errors | ClickHouse up, schema applied, column types match row payload |
| Empty Python DataFrame | Query `candles_closed` (closed bars only), symbol/timeframe match ingest |
| Broker cannot reach forwarder | Use `CEX_BROKER_ARCHIVE_FORWARDER_URL` with correct host/port |
