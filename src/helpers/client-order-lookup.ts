import type { Exchange, Order } from "ccxt";

export const CLIENT_ORDER_LOOKUP_UNSUPPORTED =
	"client_order_lookup_unsupported";

// Direct spot routes supported by the pinned CCXT fetchOrder implementation
// even though its capability map may not advertise the unified helper.
const VERIFIED_SPOT_ROUTES = new Set(["binance", "mexc", "okx"]);

/** True when the broker can look an order up by its client order id. */
// The MEXC and WEEX client ID routes are spot-only.
export function supportsClientOrderLookup(
	broker: Exchange,
	symbol?: string,
	params: Record<string, unknown> = {},
): boolean {
	if (VERIFIED_SPOT_ROUTES.has(broker.id) || broker.id === "weex") {
		const type = params.type ?? params.marketType ?? params.defaultType;
		if (
			!symbol ||
			symbol.includes(":") ||
			(type !== undefined && type !== "spot")
		)
			return false;
	}
	return (
		broker.has?.fetchOrderWithClientOrderId === true ||
		(broker.has?.fetchOrder === true && VERIFIED_SPOT_ROUTES.has(broker.id))
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
		if (!supportsClientOrderLookup(broker, symbol, params)) {
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
