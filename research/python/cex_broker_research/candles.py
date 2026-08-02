from __future__ import annotations

import pandas as pd

from cex_broker_research.client import get_client


def load_closed_candles(
    exchange: str,
    symbol: str,
    timeframe: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> pd.DataFrame:
    filters = [
        "exchange = %(exchange)s",
        "symbol = %(symbol)s",
        "timeframe = %(timeframe)s",
    ]
    params: dict[str, object] = {
        "exchange": exchange.lower(),
        "symbol": symbol,
        "timeframe": timeframe,
    }
    if start_ms is not None:
        filters.append("open_time_ms >= %(start_ms)s")
        params["start_ms"] = start_ms
    if end_ms is not None:
        filters.append("open_time_ms <= %(end_ms)s")
        params["end_ms"] = end_ms

    query = f"""
        SELECT
            open_time_ms,
            open,
            high,
            low,
            close,
            volume,
            quote_volume,
            broker_version
        FROM candles_closed
        WHERE {' AND '.join(filters)}
        ORDER BY open_time_ms
    """
    client = get_client()
    frame = client.query_df(query, parameters=params)
    if frame.empty:
        return frame
    for col in ("open", "high", "low", "close", "volume", "quote_volume"):
        if col in frame.columns:
            frame[col] = pd.to_numeric(frame[col], errors="coerce")
    frame["timestamp"] = pd.to_datetime(frame["open_time_ms"], unit="ms", utc=True)
    return frame
