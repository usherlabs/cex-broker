from cex_broker_research.symbols import ccxt_to_hb, hb_to_ccxt


def test_ccxt_to_hb() -> None:
    assert ccxt_to_hb("BTC/USDT") == "BTC-USDT"
    assert ccxt_to_hb("ETH/USDC") == "ETH-USDC"


def test_hb_to_ccxt() -> None:
    assert hb_to_ccxt("BTC-USDT") == "BTC/USDT"
    assert hb_to_ccxt("BTC/USDT") == "BTC/USDT"
