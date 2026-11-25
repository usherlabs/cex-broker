import type { Exchange } from "ccxt";
import type {
	CreateOrderPayload,
	OrderTimeInForce,
} from "../schemas/action-payloads";
import type { BrokerMarketType } from "./market-type";
import { isRecord } from "./shared/guards";

export const ORDER_TIME_IN_FORCE_INVALID = "order_time_in_force_invalid";
export const ORDER_TIME_IN_FORCE_UNSUPPORTED =
	"order_time_in_force_unsupported";

/** True when the order must rest only as a maker order (post-only). */
export function isPassiveCreateOrder(order: CreateOrderPayload): boolean {
	return order.orderIntent === "passive_only" || order.timeInForce === "PO";
}

/**
 * Checks the first-class timeInForce field against the rest of the order
 * request. Returns a stable error message, or undefined when the combination
 * is valid. It never inspects the exchange.
 */
export function checkTimeInForceRequest(
	order: CreateOrderPayload,
): string | undefined {
	const timeInForce = order.timeInForce;
	if (timeInForce === undefined) {
		return undefined;
	}
	if (order.orderType !== "limit") {
		return `${ORDER_TIME_IN_FORCE_INVALID}: timeInForce ${timeInForce} requires a limit order`;
	}
	if (order.orderIntent === "passive_only" && timeInForce !== "PO") {
		return `${ORDER_TIME_IN_FORCE_INVALID}: passive_only order intent conflicts with timeInForce ${timeInForce}`;
	}
	for (const key of [
		"timeInForce",
		"postOnly",
		"post_only",
		"time_in_force",
		"tif",
		"force",
		"ordType",
		"type",
		"orderType",
	]) {
		if (Object.hasOwn(order.params, key)) {
			return `${ORDER_TIME_IN_FORCE_INVALID}: params.${key} cannot be combined with the timeInForce field`;
		}
	}
	return undefined;
}

/**
 * Builds the CCXT createOrder params for a parsed order. Post-only (PO or
 * passive_only) is sent as CCXT's unified postOnly flag; GTC, IOC and FOK are
 * sent as CCXT's unified timeInForce param.
 */
export function buildCreateOrderParams(
	order: CreateOrderPayload,
): Record<string, string | number | boolean> {
	return {
		...order.params,
		...(order.clientOrderId !== undefined && {
			clientOrderId: order.clientOrderId,
		}),
		...(isPassiveCreateOrder(order) && { postOnly: true }),
		...(order.timeInForce !== undefined &&
			order.timeInForce !== "PO" && { timeInForce: order.timeInForce }),
	};
}

type MarketTypeFields = {
	type?: unknown;
	subType?: unknown;
	spot?: unknown;
	swap?: unknown;
	future?: unknown;
	linear?: unknown;
	inverse?: unknown;
};

function marketFeatureContainer(
	features: unknown,
	market: MarketTypeFields,
): Record<string, unknown> | undefined {
	if (!isRecord(features)) {
		return undefined;
	}
	const type =
		typeof market.type === "string"
			? market.type
			: market.spot === true
				? "spot"
				: market.swap === true
					? "swap"
					: market.future === true
						? "future"
						: undefined;
	if (type === undefined) {
		return undefined;
	}
	const byType = features[type];
	if (!isRecord(byType)) {
		return undefined;
	}
	if (type === "spot") {
		return byType;
	}
	const subType =
		typeof market.subType === "string"
			? market.subType
			: market.linear === true
				? "linear"
				: market.inverse === true
					? "inverse"
					: undefined;
	if (subType === undefined) {
		return undefined;
	}
	const bySubType = byType[subType];
	return isRecord(bySubType) ? bySubType : undefined;
}

export function precheckTimeInForce(
	broker: Exchange,
	marketType: BrokerMarketType,
	symbol: string,
	mode: OrderTimeInForce,
): string | undefined {
	const subtypes = marketType === "spot" ? [undefined] : ["linear", "inverse"];
	const supported = subtypes.some((subType) => {
		const createOrder = marketFeatureContainer(broker.features, {
			type: marketType,
			subType,
		})?.createOrder;
		return (
			isRecord(createOrder) &&
			isRecord(createOrder.timeInForce) &&
			createOrder.timeInForce[mode] === true
		);
	});
	if (!supported)
		return (
			ORDER_TIME_IN_FORCE_UNSUPPORTED +
			": " +
			broker.id +
			" does not advertise timeInForce " +
			mode +
			" for " +
			symbol
		);
}

export type TimeInForceSupport =
	| { supported: true }
	| { supported: false; message: string };

/**
 * Reports whether the exchange advertises a time-in-force value for a loaded
 * market, from CCXT's `features[type][subType].createOrder.timeInForce`.
 * Anything not advertised as true is unsupported: a hard bound must not depend
 * on a value the venue may ignore.
 */
export function resolveTimeInForceSupport(
	broker: Exchange,
	symbol: string,
	timeInForce: OrderTimeInForce,
): TimeInForceSupport {
	const markets = (broker as Exchange & { markets?: Record<string, unknown> })
		.markets;
	const market = isRecord(markets) ? markets[symbol] : undefined;
	const container = isRecord(market)
		? marketFeatureContainer(
				(broker as Exchange & { features?: unknown }).features,
				market as MarketTypeFields,
			)
		: undefined;
	const createOrder = container?.createOrder;
	const advertised = isRecord(createOrder)
		? createOrder.timeInForce
		: undefined;
	if (isRecord(advertised) && advertised[timeInForce] === true) {
		return { supported: true };
	}
	return {
		supported: false,
		message: `${ORDER_TIME_IN_FORCE_UNSUPPORTED}: ${broker.id ?? "exchange"} does not advertise timeInForce ${timeInForce} for ${symbol}`,
	};
}
