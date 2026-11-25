import type { Exchange, Order } from "ccxt";

export const CLIENT_ORDER_LOOKUP_UNSUPPORTED =
	"client_order_lookup_unsupported";

/**
 * Exchanges whose CCXT `fetchOrder` reads a unified `clientOrderId` param and
 * queries the venue by it. Derived from the pinned CCXT source; the test suite
 * re-checks every entry against the installed CCXT so an upgrade that drops
 * the mapping fails the build instead of silently querying by an empty id.
 */
export const CLIENT_ORDER_ID_FETCH_ORDER_EXCHANGES: ReadonlySet<string> =
	new Set([
		"apex",
		"aster",
		"binance",
		"binancecoinm",
		"binanceus",
		"binanceusdm",
		"bitget",
		"bithumb",
		"bitrue",
		"bitstamp",
		"bitvavo",
		"coinbaseexchange",
		"coinsph",
		"delta",
		"extended",
		"grvt",
		"htx",
		"hyperliquid",
		"kraken",
		"kucoin",
		"kucoinfutures",
		"mexc",
		"modetrade",
		"myokx",
		"okx",
		"okxus",
		"paradex",
		"phemex",
		"weex",
		"woo",
		"woofipro",
	]);

/** True when the broker can look an order up by its client order id. */
export function supportsClientOrderLookup(broker: Exchange): boolean {
	return (
		broker.has?.fetchOrderWithClientOrderId === true ||
		CLIENT_ORDER_ID_FETCH_ORDER_EXCHANGES.has(String(broker.id))
	);
}

export function clientOrderLookupUnsupportedMessage(broker: Exchange): string {
	return `${CLIENT_ORDER_LOOKUP_UNSUPPORTED}: ${broker.id ?? "exchange"} does not support order lookup by clientOrderId`;
}

/**
 * Fetches one order by orderId or by clientOrderId. A client order id lookup
 * goes through CCXT's `fetchOrderWithClientOrderId`, and is refused with a
 * stable `client_order_lookup_unsupported` error where the exchange has no
 * mapping, rather than sending an empty order id.
 */
export async function fetchOrderByReference(
	broker: Exchange,
	reference: { orderId?: string; clientOrderId?: string },
	symbol: string | undefined,
	params: Record<string, string | number>,
): Promise<Order> {
	if (reference.clientOrderId !== undefined) {
		if (!supportsClientOrderLookup(broker)) {
			throw new Error(clientOrderLookupUnsupportedMessage(broker));
		}
		return broker.fetchOrderWithClientOrderId(reference.clientOrderId, symbol, {
			...params,
		});
	}
	if (reference.orderId === undefined) {
		throw new Error("orderId or clientOrderId is required");
	}
	return broker.fetchOrder(reference.orderId, symbol, { ...params });
}
