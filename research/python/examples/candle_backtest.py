#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

from cex_broker_research.backtest_simple import run_sma_crossover
from cex_broker_research.candles import load_closed_candles
from cex_broker_research.export_hummingbot import export_hummingbot_params

EXCHANGE = "binance"
SYMBOL = "BTC/USDT"
TIMEFRAME = "1m"
FAST_WINDOW = 10
SLOW_WINDOW = 30
OUTPUT = Path(__file__).resolve().parents[0] / "output" / "hummingbot_params.yaml"


def main() -> None:
    frame = load_closed_candles(EXCHANGE, SYMBOL, TIMEFRAME)
    summary = run_sma_crossover(frame, FAST_WINDOW, SLOW_WINDOW)
    output = export_hummingbot_params(
        OUTPUT,
        exchange=EXCHANGE,
        symbol=SYMBOL,
        timeframe=TIMEFRAME,
        summary=summary,
        fast_window=FAST_WINDOW,
        slow_window=SLOW_WINDOW,
    )
    print(f"Loaded {len(frame)} closed candles")
    print(f"Exported Hummingbot tuning params to {output}")


if __name__ == "__main__":
    main()
