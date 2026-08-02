"""
MarketDataProvider functional contract coverage for cex-broker + Hummingbot integration.

The full MarketDataProvider class lives in Hummingbot (hummingbot/data_feed/market_data_provider.py).
cex-broker extends only the **Candles** path via connector ``cex_broker_clickhouse``.

Run: python research/hummingbot/verify_market_data_contract.py
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Coverage(str, Enum):
	"""Who implements this contract group."""

	HUMMINGBOT_NATIVE = "hummingbot_native"
	CLICKHOUSE_CANDLES = "clickhouse_candles_extension"
	NOT_IN_CEX_BROKER = "not_in_cex_broker"


@dataclass(frozen=True)
class ContractGroup:
	name: str
	methods: tuple[str, ...]
	coverage: Coverage
	notes: str


MARKET_DATA_PROVIDER_CONTRACT: tuple[ContractGroup, ...] = (
	ContractGroup(
		"Lifecycle",
		("stop", "ready", "time"),
		Coverage.HUMMINGBOT_NATIVE,
		"HB MarketDataProvider; ClickHouse feeds participate in ready via CandlesBase.ready",
	),
	ContractGroup(
		"Rate Sources",
		("initialize_rate_sources", "remove_rate_sources"),
		Coverage.HUMMINGBOT_NATIVE,
		"Requires exchange/gateway connectors; not ClickHouse",
	),
	ContractGroup(
		"Connectors",
		("get_connector", "get_connector_with_fallback"),
		Coverage.HUMMINGBOT_NATIVE,
		"cex_broker_clickhouse is a candle feed connector name, not a trading ConnectorBase",
	),
	ContractGroup(
		"Balances",
		("get_balance", "get_available_balance"),
		Coverage.HUMMINGBOT_NATIVE,
		"Exchange connector only",
	),
	ContractGroup(
		"Market Prices",
		("get_price_by_type", "get_rate"),
		Coverage.HUMMINGBOT_NATIVE,
		"Exchange/gateway connectors",
	),
	ContractGroup(
		"Funding",
		("get_funding_info",),
		Coverage.HUMMINGBOT_NATIVE,
		"Perpetual connectors only",
	),
	ContractGroup(
		"Trading Metadata",
		("get_trading_pairs", "get_trading_rules"),
		Coverage.HUMMINGBOT_NATIVE,
		"Exchange connector metadata",
	),
	ContractGroup(
		"Quantization",
		("quantize_order_price", "quantize_order_amount"),
		Coverage.HUMMINGBOT_NATIVE,
		"Exchange trading rules",
	),
	ContractGroup(
		"Order Books",
		(
			"initialize_order_book",
			"initialize_order_books",
			"remove_order_book",
			"remove_order_books",
			"get_order_book",
			"get_order_book_snapshot",
		),
		Coverage.HUMMINGBOT_NATIVE,
		"Live exchange order books; cex-broker archives OB to ClickHouse separately",
	),
	ContractGroup(
		"Order Book Analytics",
		(
			"get_price_for_volume",
			"get_price_for_quote_volume",
			"get_volume_for_price",
			"get_quote_volume_for_price",
			"get_vwap_for_volume",
		),
		Coverage.HUMMINGBOT_NATIVE,
		"Requires live order book from exchange connector",
	),
	ContractGroup(
		"Candles (live window)",
		(
			"initialize_candles_feed",
			"initialize_candles_feed_list",
			"get_candles_feed",
			"stop_candle_feed",
			"get_candles_df",
		),
		Coverage.CLICKHOUSE_CANDLES,
		"Supported when connector=cex_broker_clickhouse after register_clickhouse_feed.py",
	),
	ContractGroup(
		"Historical Candles",
		("get_historical_candles_df",),
		Coverage.CLICKHOUSE_CANDLES,
		"Uses CandlesBase.fetch_candles / get_historical_candles backed by ClickHouse poll",
	),
)

CONNECTOR_NAME = "cex_broker_clickhouse"
