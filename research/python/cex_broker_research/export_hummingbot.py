from __future__ import annotations

from pathlib import Path

import yaml

from cex_broker_research.backtest_simple import BacktestSummary
from cex_broker_research.symbols import ccxt_to_hb


def export_hummingbot_params(
    output_path: str | Path,
    *,
    exchange: str,
    symbol: str,
    timeframe: str,
    summary: BacktestSummary,
    fast_window: int,
    slow_window: int,
) -> Path:
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "research_source": "cex-broker-clickhouse",
        "hummingbot": {
            "connector": exchange,
            "trading_pair": ccxt_to_hb(symbol),
            "candles_interval": timeframe,
            "strategy_notes": "Copy these values into your Hummingbot strategy config manually.",
        },
        "indicators": {
            "fast_sma_window": fast_window,
            "slow_sma_window": slow_window,
        },
        "backtest_summary": {
            "trades": summary.trades,
            "total_return": round(summary.total_return, 6),
            "win_rate": round(summary.win_rate, 6),
        },
    }

    destination.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    return destination
