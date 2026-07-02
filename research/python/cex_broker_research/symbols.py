from __future__ import annotations


def ccxt_to_hb(symbol: str) -> str:
    return symbol.replace("/", "-")


def hb_to_ccxt(symbol: str) -> str:
    if "/" in symbol:
        return symbol
    if "-" not in symbol:
        return symbol
    base, quote = symbol.split("-", 1)
    return f"{base}/{quote}"
