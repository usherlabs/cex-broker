# Python research toolkit

Installable package **`cex-broker-research`** for loading archived candles from ClickHouse, rolling up timeframes, running a simple SMA crossover backtest, and exporting Hummingbot-oriented params.

## Install

```bash
cd research/python
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

Requires Python **3.11+**.

## Configure ClickHouse

```bash
export CLICKHOUSE_HOST=localhost
export CLICKHOUSE_PORT=8123
export CLICKHOUSE_DATABASE=market_data
```

Use the same host/port as your ClickHouse instance (compose default: `8123`).

## Example backtest

```bash
python examples/candle_backtest.py
```

Writes `examples/output/hummingbot_params.yaml` with symbol/timeframe hints for manual Hummingbot tuning.

## Package overview

| Module | Purpose |
|--------|---------|
| `candles.py` | Load closed candles into pandas |
| `live_candles.py` | Poll forming + closed bars (used by Hummingbot feed) |
| `rollups.py` | Roll `1m` → higher timeframes |
| `backtest_simple.py` | SMA crossover backtest |
| `export_hummingbot.py` | YAML param export |
| `symbols.py` | CCXT ↔ Hummingbot pair mapping |

```python
from cex_broker_research import load_closed_candles, ccxt_to_hb, run_sma_crossover

df = load_closed_candles(exchange="binance", symbol="BTC/USDT", timeframe="1m")
ccxt_to_hb("BTC/USDT")  # "BTC-USDT"
```

Closed bars only — query path uses `market_data.candles_closed` (or equivalent filter).

## Symbol mapping

| CCXT (broker) | Hummingbot |
|---------------|------------|
| `BTC/USDT` | `BTC-USDT` |
| `binance` | `binance` / `binance_perpetual` |

```python
from cex_broker_research.symbols import ccxt_to_hb, hb_to_ccxt
```

## Tests

```bash
pytest
```

## Related

- [research/README.md](../README.md) — full stack setup
- [research/hummingbot/README.md](../hummingbot/README.md) — live candles in Hummingbot strategies
- [docs/research-backtest.md](../../docs/research-backtest.md) — Path B guide
