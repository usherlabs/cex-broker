from __future__ import annotations

import pandas as pd


def rollup_candles(frame: pd.DataFrame, target_ms: int) -> pd.DataFrame:
    if frame.empty:
        return frame.copy()

    working = frame.sort_values("open_time_ms").copy()
    working["bucket_ms"] = (working["open_time_ms"] // target_ms) * target_ms

    grouped = working.groupby("bucket_ms", as_index=False).agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    )
    grouped["open_time_ms"] = grouped["bucket_ms"]
    grouped["timestamp"] = pd.to_datetime(grouped["bucket_ms"], unit="ms", utc=True)
    return grouped
