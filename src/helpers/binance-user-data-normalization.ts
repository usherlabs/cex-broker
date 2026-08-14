import type { Exchange } from "@usherlabs/ccxt";
import { asRecord } from "./shared/guards";

function requireQuantity(
	entry: Record<string, unknown>,
	key: "f" | "l",
): string {
	const value = entry[key];
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	throw new Error(`Invalid Binance balance quantity: ${key}`);
}

export async function normalizeBinanceSpotBalanceEvent(
	exchange: Exchange,
	event: Record<string, unknown>,
): Promise<unknown> {
	if (event.e !== "outboundAccountPosition") {
		return exchange.fetchBalance({ type: "spot" });
	}

	if (!Array.isArray(event.B)) {
		throw new Error("Invalid Binance outboundAccountPosition balances");
	}

	const timestamp =
		typeof event.E === "number" && Number.isFinite(event.E)
			? event.E
			: undefined;
	const balance: Record<string, unknown> = {
		info: event,
		...(timestamp !== undefined && {
			timestamp,
			datetime: new Date(timestamp).toISOString(),
		}),
	};

	for (const rawEntry of event.B) {
		const entry = asRecord(rawEntry);
		const asset = entry?.a;
		if (!entry || typeof asset !== "string" || asset.length === 0) {
			throw new Error("Invalid Binance outboundAccountPosition asset");
		}
		balance[asset] = {
			free: requireQuantity(entry, "f"),
			used: requireQuantity(entry, "l"),
		};
	}

	return exchange.safeBalance(balance);
}

function getTradeId(value: unknown): string | undefined {
	if (
		(typeof value === "number" && Number.isFinite(value)) ||
		(typeof value === "string" && value.length > 0)
	) {
		const tradeId = String(value);
		return tradeId === "-1" ? undefined : tradeId;
	}
	return undefined;
}

export function normalizeBinanceExecutionReport(
	exchange: Exchange,
	event: Record<string, unknown>,
): Record<string, unknown> {
	const parsed = asRecord(exchange.parseWsOrder(event));
	if (!parsed) {
		throw new Error("Binance executionReport did not parse as an order");
	}

	// executionReport commission is for the latest fill, while order stream
	// consumers interpret fee fields as cumulative snapshots.
	const { fee: _fee, fees: _fees, ...order } = parsed;
	const tradeId = getTradeId(event.t);
	return tradeId === undefined ? order : { ...order, tradeId };
}
