from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from cex_broker_research.candles import load_closed_candles
from cex_broker_research.symbols import ccxt_to_hb


@dataclass(frozen=True)
class BacktestSummary:
    trades: int
    total_return: float
    win_rate: float


def run_sma_crossover(
    frame: pd.DataFrame,
    fast_window: int = 10,
    slow_window: int = 30,
) -> BacktestSummary:
    if frame.empty:
        return BacktestSummary(trades=0, total_return=0.0, win_rate=0.0)

    data = frame.sort_values("open_time_ms").copy()
    data["fast_sma"] = data["close"].rolling(fast_window).mean()
    data["slow_sma"] = data["close"].rolling(slow_window).mean()
    data["signal"] = (data["fast_sma"] > data["slow_sma"]).astype(int)
    data["position"] = data["signal"].shift(1).fillna(0)
    data["returns"] = data["close"].pct_change().fillna(0)
    data["strategy_returns"] = data["position"] * data["returns"]

    trades = int(data["position"].diff().abs().fillna(0).sum() / 2)
    total_return = float((1 + data["strategy_returns"]).prod() - 1)

    completed_pnls: list[float] = []
    entry_price: float | None = None
    entry_side = 0
    for row in data.itertuples(index=False):
        position = int(row.position)
        close = float(row.close)
        if entry_price is None and position != 0:
            entry_price = close
            entry_side = position
            continue
        if entry_price is not None and position != entry_side:
            if entry_side > 0:
                completed_pnls.append((close - entry_price) / entry_price)
            else:
                completed_pnls.append((entry_price - close) / entry_price)
            entry_price = close if position != 0 else None
            entry_side = position

    winning_trades = sum(1 for pnl in completed_pnls if pnl > 0)
    win_rate = float(winning_trades / max(len(completed_pnls), 1))
    return BacktestSummary(trades=trades, total_return=total_return, win_rate=win_rate)


def main() -> None:
    exchange = "binance"
    symbol = "BTC/USDT"
    timeframe = "1m"
    frame = load_closed_candles(exchange, symbol, timeframe)
    summary = run_sma_crossover(frame)
    print(f"Loaded {len(frame)} closed candles for {exchange} {symbol} {timeframe}")
    print(f"Hummingbot pair hint: {ccxt_to_hb(symbol)}")
    print(
        "SMA crossover summary:",
        f"trades={summary.trades}",
        f"total_return={summary.total_return:.4f}",
        f"win_rate={summary.win_rate:.4f}",
    )


if __name__ == "__main__":
    main()
