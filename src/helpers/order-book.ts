import type { Exchange } from "@usherlabs/ccxt";

export const ORDER_BOOK_CALL_METHODS = {
	FETCH_CAPABILITY: "fetch_order_book_capability",
	FETCH_SNAPSHOT: "fetch_order_book_snapshot",
	FETCH_HISTORICAL_SNAPSHOTS: "fetch_historical_order_book_snapshots",
} as const;

export type OrderBookCallMethod =
	(typeof ORDER_BOOK_CALL_METHODS)[keyof typeof ORDER_BOOK_CALL_METHODS];

export const ORDER_BOOK_CONSTRUCTION_MODES = {
	SAMPLED_TOP_N_SNAPSHOT: "sampled_top_n_snapshot",
	EXACT_L2_RECONSTRUCTION: "exact_l2_reconstruction",
} as const;

export type OrderBookConstructionMode =
	(typeof ORDER_BOOK_CONSTRUCTION_MODES)[keyof typeof ORDER_BOOK_CONSTRUCTION_MODES];

export const HISTORICAL_ORDER_BOOK_PROVIDER_UNSUPPORTED =
	"historical_order_book_provider_unsupported";

const ORDER_BOOK_METHOD_VALUES = new Set<string>(
	Object.values(ORDER_BOOK_CALL_METHODS),
);

const ORDER_BOOK_CONSTRUCTION_MODE_VALUES = new Set<string>(
	Object.values(ORDER_BOOK_CONSTRUCTION_MODES),
);

export type OrderBookCallPayload = {
	method: OrderBookCallMethod;
	exchange: string;
	symbol: string;
	depthLimit: number;
	constructionMode: OrderBookConstructionMode;
	start?: string;
	end?: string;
	cadence?: string;
};

export type OrderBookCallParseResult =
	| { kind: "not_order_book" }
	| { kind: "error"; message: string }
	| { kind: "order_book"; payload: OrderBookCallPayload };

export type NormalizedOrderBookSnapshot = {
	bids: number[][];
	asks: number[][];
	timestamp: number | string | boolean | null;
	receivedTimestamp: number;
	exchange: string;
	symbol: string;
	depthLimit: number;
	sequence?: number | string | boolean;
};

type Scalar = string | number | boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function payloadValue(
	payload: Record<string, string> | undefined,
	...aliases: string[]
): string | undefined {
	for (const alias of aliases) {
		const value = nonEmptyString(payload?.[alias]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function parsePositiveInteger(value: string | undefined, field: string) {
	if (value === undefined) {
		return {
			ok: false as const,
			message: `ValidationError: ${field} is required`,
		};
	}
	if (!/^[1-9]\d*$/.test(value)) {
		return {
			ok: false as const,
			message: `ValidationError: ${field} must be a positive integer`,
		};
	}
	return { ok: true as const, value: Number.parseInt(value, 10) };
}

function parseConstructionMode(value: string | undefined) {
	const mode = value ?? ORDER_BOOK_CONSTRUCTION_MODES.SAMPLED_TOP_N_SNAPSHOT;
	if (!ORDER_BOOK_CONSTRUCTION_MODE_VALUES.has(mode)) {
		return {
			ok: false as const,
			message: `ValidationError: constructionMode must be ${Array.from(
				ORDER_BOOK_CONSTRUCTION_MODE_VALUES,
			).join(" or ")}`,
		};
	}
	return { ok: true as const, value: mode as OrderBookConstructionMode };
}

function parseHistoricalTimestamp(value: string | undefined, field: string) {
	if (value === undefined) {
		return {
			ok: false as const,
			message: `ValidationError: ${field} is required`,
		};
	}
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return {
			ok: false as const,
			message: `ValidationError: ${field} must be an ISO timestamp`,
		};
	}
	return { ok: true as const, value, timestamp };
}

function parseCadence(value: string | undefined) {
	if (value === undefined) {
		return {
			ok: false as const,
			message: "ValidationError: cadence is required",
		};
	}
	if (!/^[1-9]\d*(ms|s|m|h)$/.test(value)) {
		return {
			ok: false as const,
			message:
				"ValidationError: cadence must be a positive duration such as 1s",
		};
	}
	return { ok: true as const, value };
}

export function isOrderBookCallMethod(
	value: unknown,
): value is OrderBookCallMethod {
	return typeof value === "string" && ORDER_BOOK_METHOD_VALUES.has(value);
}

export function parseOrderBookCallPayload(
	payload: Record<string, string> | undefined,
	request: { exchange?: string; symbol?: string },
): OrderBookCallParseResult {
	const method = payloadValue(payload, "method", "functionName");
	if (!isOrderBookCallMethod(method)) {
		return { kind: "not_order_book" };
	}

	const exchange = nonEmptyString(request.exchange);
	if (exchange === undefined) {
		return { kind: "error", message: "ValidationError: cex is required" };
	}
	const symbol = nonEmptyString(request.symbol);
	if (symbol === undefined) {
		return { kind: "error", message: "ValidationError: symbol is required" };
	}

	const parsedDepthLimit = parsePositiveInteger(
		payloadValue(payload, "depthLimit", "depth_limit"),
		"depthLimit",
	);
	if (!parsedDepthLimit.ok) {
		return { kind: "error", message: parsedDepthLimit.message };
	}

	const parsedConstructionMode = parseConstructionMode(
		payloadValue(payload, "constructionMode", "construction_mode"),
	);
	if (!parsedConstructionMode.ok) {
		return { kind: "error", message: parsedConstructionMode.message };
	}

	const parsed: OrderBookCallPayload = {
		method,
		exchange,
		symbol,
		depthLimit: parsedDepthLimit.value,
		constructionMode: parsedConstructionMode.value,
	};

	if (method !== ORDER_BOOK_CALL_METHODS.FETCH_HISTORICAL_SNAPSHOTS) {
		return { kind: "order_book", payload: parsed };
	}

	const parsedStart = parseHistoricalTimestamp(
		payloadValue(payload, "start"),
		"start",
	);
	if (!parsedStart.ok) {
		return { kind: "error", message: parsedStart.message };
	}
	const parsedEnd = parseHistoricalTimestamp(
		payloadValue(payload, "end"),
		"end",
	);
	if (!parsedEnd.ok) {
		return { kind: "error", message: parsedEnd.message };
	}
	if (parsedStart.timestamp >= parsedEnd.timestamp) {
		return {
			kind: "error",
			message: "ValidationError: start must be before end",
		};
	}
	const parsedCadence = parseCadence(payloadValue(payload, "cadence"));
	if (!parsedCadence.ok) {
		return { kind: "error", message: parsedCadence.message };
	}

	return {
		kind: "order_book",
		payload: {
			...parsed,
			start: parsedStart.value,
			end: parsedEnd.value,
			cadence: parsedCadence.value,
		},
	};
}

export function parseOptionalDepthLimit(
	value: string | undefined,
): number | undefined {
	const parsed = parsePositiveInteger(nonEmptyString(value), "depthLimit");
	return parsed.ok ? parsed.value : undefined;
}

function scalarByAlias(
	payload: Record<string, unknown>,
	aliases: string[],
): Scalar | undefined {
	for (const alias of aliases) {
		const value = payload[alias];
		if (isScalar(value)) {
			return value;
		}
	}
	return undefined;
}

function normalizeSide(
	payload: Record<string, unknown>,
	side: "bids" | "asks",
	depthLimit: number,
) {
	const rawLevels = payload[side];
	if (!Array.isArray(rawLevels)) {
		throw new Error(`Malformed order book: ${side} must be an array`);
	}
	return rawLevels.slice(0, depthLimit).map((level, index) => {
		if (!Array.isArray(level) || level.length < 2) {
			throw new Error(
				`Malformed order book: ${side}[${index}] must be [price, amount]`,
			);
		}
		const price = Number(level[0]);
		const amount = Number(level[1]);
		if (!Number.isFinite(price) || !Number.isFinite(amount)) {
			throw new Error(
				`Malformed order book: ${side}[${index}] must be numeric`,
			);
		}
		return [price, amount];
	});
}

export function normalizeOrderBookSnapshot(
	orderBook: unknown,
	options: {
		exchange: string;
		symbol: string;
		depthLimit: number;
		receivedTimestamp?: number;
	},
): NormalizedOrderBookSnapshot {
	if (!isRecord(orderBook)) {
		throw new Error("Malformed order book: expected object");
	}

	const receivedTimestamp = options.receivedTimestamp ?? Date.now();
	const timestamp =
		scalarByAlias(orderBook, ["timestamp"]) ?? receivedTimestamp;
	const sequence = scalarByAlias(orderBook, [
		"sequence",
		"updateId",
		"lastUpdateId",
		"nonce",
	]);
	const normalized: NormalizedOrderBookSnapshot = {
		bids: normalizeSide(orderBook, "bids", options.depthLimit),
		asks: normalizeSide(orderBook, "asks", options.depthLimit),
		timestamp,
		receivedTimestamp,
		exchange: options.exchange,
		symbol: options.symbol,
		depthLimit: options.depthLimit,
	};
	if (sequence !== undefined) {
		normalized.sequence = sequence;
	}
	return normalized;
}

function supportsBrokerMethod(broker: Exchange, method: string): boolean {
	const fn = (broker as unknown as Record<string, unknown>)[method];
	const hasValue = (broker.has as Record<string, unknown> | undefined)?.[
		method
	];
	return typeof fn === "function" && hasValue !== false;
}

export function buildOrderBookCapability(
	broker: Exchange,
	payload: Pick<
		OrderBookCallPayload,
		"exchange" | "symbol" | "depthLimit" | "constructionMode"
	>,
) {
	return {
		exchange: payload.exchange,
		symbol: payload.symbol,
		provider: "ccxt_order_book",
		maxDepth: payload.depthLimit,
		timestampPrecision: "milliseconds",
		constructionMode: payload.constructionMode,
		supportsCurrentSnapshot: supportsBrokerMethod(broker, "fetchOrderBook"),
		supportsLiveStream: supportsBrokerMethod(broker, "watchOrderBook"),
		supportsHistoricalSnapshots: false,
		supportsSampledTopN: false,
		supportsExactL2Reconstruction: false,
	};
}

export function buildHistoricalOrderBookUnsupported(
	payload: OrderBookCallPayload,
) {
	return {
		exchange: payload.exchange,
		symbol: payload.symbol,
		provider: "ccxt_order_book",
		constructionMode: payload.constructionMode,
		depthLimit: payload.depthLimit,
		start: payload.start,
		end: payload.end,
		cadence: payload.cadence,
		unsupported: true,
		unsupportedReason: HISTORICAL_ORDER_BOOK_PROVIDER_UNSUPPORTED,
	};
}
