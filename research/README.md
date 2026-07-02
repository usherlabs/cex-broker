# Research

Tools for working with **cex-broker archived market data** in ClickHouse: live ingest verification, browser charts, Python backtests, and optional Hummingbot candle feeds.

Full walkthrough: [docs/research-backtest.md](../docs/research-backtest.md).

## Layout

| Path | Purpose |
|------|---------|
| [`candle-viewer/`](candle-viewer/) | Browser chart (Lightweight Charts) polling `market_data.candles` |
| [`python/`](python/) | `cex-broker-research` package — load candles, rollups, simple backtest, Hummingbot param export |
| [`hummingbot/`](hummingbot/) | Optional `MarketDataProvider` feed that polls the same ClickHouse candles |

## Data flow

```text
cex-broker Subscribe (ORDERBOOK, OHLCV, TRADES, TICKER, …)
        → BrokerExecutionArchiver
        → archive-forwarder  POST /archive  (port 8090)
        → ClickHouse  market_data.*
        → candle-viewer / Python / Hummingbot
```

### ClickHouse tables (`schema/clickhouse/market_data.sql`)

| Table | Source stream | Notes |
|-------|---------------|--------|
| `market_data.candles` | OHLCV | Forming + closed bars; use `candles_closed` view for backtests |
| `market_data.orderbook_snapshots` | ORDERBOOK | TOB scalars + L2 depth arrays in one row per sample |
| `market_data.cex_trades` | TRADES | Public trade prints |
| `market_data.cex_ticker_events` | TICKER | Ticker snapshots |
| `market_data.cex_stream_events` | BALANCE, ORDERS, … | Redacted JSON payloads |

Example queries: [`schema/clickhouse/research_queries.sql`](../schema/clickhouse/research_queries.sql).

## Quick start (local)

### 1. ClickHouse + forwarder

```bash
docker network create fiet-sandbox || true
docker compose -f docker/clickhouse-research.compose.yml up -d
curl http://localhost:8090/health
```

Or run the forwarder on the host (schema is applied on startup):

```bash
CLICKHOUSE_PORT=8123 bun run start-archive-forwarder
```

### 2. Broker with archive enabled

```bash
CEX_BROKER_ARCHIVE_FORWARDER_URL=http://localhost:8090/archive \
CEX_BROKER_DEPLOYMENT_ID=local-dev \
CEX_BROKER_MARKET_ARCHIVE_ENABLED=true \
bun run start-broker --policy policy/policy.json --port 8086 --whitelistAll
```

### 3. Ingest market data

Multi-stream watch (ORDERBOOK, OHLCV, TRADES, TICKER) for default symbols:

```bash
SYMBOLS=BTC/USDT,BNB/USDT,DOGE/USDT bun run start-archive-watch
```

OHLCV-only seeder: `bun run examples/archive-ohlcv-subscribe.ts`.

### 4. Live candle chart

```bash
CLICKHOUSE_PORT=8123 bun run start-candle-viewer
```

Open [http://localhost:8091](http://localhost:8091). The UI polls `/api/candles` every 500ms (configurable). Higher timeframes in the chart are rolled up from archived `1m` bars.

See [`candle-viewer/README.md`](candle-viewer/README.md) for env vars.

### 5. Python backtest

```bash
cd research/python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

export CLICKHOUSE_HOST=localhost CLICKHOUSE_PORT=8123 CLICKHOUSE_DATABASE=market_data
python examples/candle_backtest.py
```

See [`python/README.md`](python/README.md).

## Dev watchers (auto-restart on change)

From repo root:

| Script | Watches | Restarts |
|--------|---------|----------|
| `bun run dev:candle-viewer` | `research/candle-viewer/**` | candle viewer |
| `bun run dev:archive-forwarder` | `services/archive-forwarder`, `schema/clickhouse` | forwarder (+ schema) |
| `bun run dev:archive-watch` | `examples`, `src/helpers/market-data-archive`, subscribe handler | archive watch client |

Example — chart dev loop with a local ClickHouse on port `18123`:

```bash
CLICKHOUSE_PORT=18123 bun run dev:candle-viewer
```

Broker hot reload (separate from research): `bun run start-broker-server`.

## Key environment variables

### Broker → forwarder

| Variable | Default | Purpose |
|----------|---------|---------|
| `CEX_BROKER_ARCHIVE_FORWARDER_URL` | derived from host/port | Forwarder POST target |
| `CEX_BROKER_MARKET_ARCHIVE_ENABLED` | `true` | Enable market_data archiving |
| `CEX_BROKER_DEPLOYMENT_ID` | — | Tag rows in ClickHouse |
| `CEX_BROKER_ORDERBOOK_INTERVAL_MS` | `1000` | Orderbook archive sample rate |
| `CEX_BROKER_ORDERBOOK_TOB_INTERVAL_MS` | — | Legacy alias for orderbook interval |

### ClickHouse clients (viewer, Python, forwarder)

| Variable | Default |
|----------|---------|
| `CLICKHOUSE_HOST` | `localhost` |
| `CLICKHOUSE_PORT` | `8123` (forwarder) / set per tool |
| `CLICKHOUSE_DATABASE` | `market_data` |

### Candle viewer

| Variable | Default |
|----------|---------|
| `CANDLE_VIEWER_PORT` | `8091` |
| `CANDLE_VIEWER_POLL_MS` | `500` |
| `CANDLE_VIEWER_SYMBOLS` | `BTC/USDT,BNB/USDT,DOGE/USDT` |

## Tests

```bash
# TypeScript (viewer + archive)
bun test test/candle-viewer.test.ts test/market-data-archive.test.ts

# Python
cd research/python && pytest
```

## Related docs

- [docs/research-backtest.md](../docs/research-backtest.md) — end-to-end Path B guide
- [research/hummingbot/README.md](hummingbot/README.md) — live HB candles from ClickHouse
- [README.md](../README.md) — main broker documentation
