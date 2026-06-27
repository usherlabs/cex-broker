# Live candle viewer

Browser candlestick chart backed by ClickHouse `market_data.candles`. Includes the **forming** bar (not just closed candles).

## Run

```bash
CLICKHOUSE_PORT=8123 bun run start-candle-viewer
```

Open [http://localhost:8091](http://localhost:8091).

Dev mode (restart on file changes):

```bash
CLICKHOUSE_PORT=8123 bun run dev:candle-viewer
```

## How it works

- Serves static UI from `public/index.html` (TradingView **Lightweight Charts**).
- Client polls `GET /api/candles` on an interval (default **500ms**).
- Server reads `market_data.candles` with `FINAL` for deduped OHLCV.
- Timeframes `5m`, `15m`, `1h` are **rolled up in-process** from archived `1m` bars — only `1m` needs to be ingested.

## API

| Route | Description |
|-------|-------------|
| `GET /health` | ClickHouse ping |
| `GET /api/config` | Defaults, symbols, poll interval |
| `GET /api/candles?exchange=&symbol=&timeframe=&limit=` | Candle JSON |
| `GET /` | Chart UI |

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CANDLE_VIEWER_PORT` | `8091` | HTTP port |
| `CANDLE_VIEWER_POLL_MS` | `500` | Client poll interval |
| `CANDLE_VIEWER_SYMBOLS` | `BTC/USDT,BNB/USDT,DOGE/USDT` | Symbol dropdown |
| `CANDLE_VIEWER_SYMBOL` | `BTC/USDT` | Initial symbol |
| `CANDLE_VIEWER_TIMEFRAME` | `1m` | Initial timeframe |
| `CANDLE_VIEWER_LIMIT` | `300` | Bars returned |
| `CANDLE_VIEWER_EXCHANGE` | `binance` | Exchange filter |
| `CLICKHOUSE_HOST` | `localhost` | |
| `CLICKHOUSE_PORT` | `8123` | |
| `CLICKHOUSE_DATABASE` | `market_data` | |

## Prerequisites

Archive ingest must be running (broker + forwarder + subscribe watch). See [research/README.md](../README.md).

Verify data:

```sql
SELECT max(open_time_ms), count()
FROM market_data.candles
WHERE exchange = 'binance' AND symbol = 'DOGE/USDT' AND timeframe = '1m';
```

## Tests

```bash
bun test test/candle-viewer.test.ts
```
