import { asRecord } from "../shared/guards";

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function toNumber(value: unknown): number | undefined {
	if (isFiniteNumber(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

function toStringId(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
}

function scalarTimestampMs(value: unknown, fallbackMs: number): number {
	const numeric = toNumber(value);
	if (numeric !== undefined) {
		return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return fallbackMs;
}

export type ParsedTrade = {
	tradeId: string;
	eventTimeMs: number;
	side: string;
	price: number;
	amount: number;
	cost?: number;
	takerOrMaker?: string;
};

export type ParsedTicker = {
	eventTimeMs: number;
	last?: number;
	bid?: number;
	ask?: number;
	high?: number;
	low?: number;
	open?: number;
	close?: number;
	baseVolume?: number;
	quoteVolume?: number;
	change?: number;
	percentage?: number;
};

export function parseTrade(value: unknown): ParsedTrade | null {
	const record = asRecord(value);
	if (!record) {
		return null;
	}

	const tradeId = toStringId(record.id);
	const price = toNumber(record.price);
	const amount = toNumber(record.amount);
	const side =
		typeof record.side === "string" ? record.side.toLowerCase() : undefined;
	if (!tradeId || price === undefined || amount === undefined || !side) {
		return null;
	}

	const parsed: ParsedTrade = {
		tradeId,
		eventTimeMs: scalarTimestampMs(record.timestamp, Date.now()),
		side,
		price,
		amount,
	};
	const cost = toNumber(record.cost);
	if (cost !== undefined) {
		parsed.cost = cost;
	}
	if (typeof record.takerOrMaker === "string") {
		parsed.takerOrMaker = record.takerOrMaker;
	}
	return parsed;
}

export function extractTrades(payload: unknown): ParsedTrade[] {
	if (Array.isArray(payload)) {
		return payload
			.map((entry) => parseTrade(entry))
			.filter((entry): entry is ParsedTrade => entry !== null);
	}
	const single = parseTrade(payload);
	return single ? [single] : [];
}

export function parseTicker(
	value: unknown,
	fallbackMs: number,
): ParsedTicker | null {
	const record = asRecord(value);
	if (!record) {
		return null;
	}

	const parsed: ParsedTicker = {
		eventTimeMs: scalarTimestampMs(record.timestamp, fallbackMs),
	};
	const fields: Array<[keyof ParsedTicker, unknown]> = [
		["last", record.last],
		["bid", record.bid],
		["ask", record.ask],
		["high", record.high],
		["low", record.low],
		["open", record.open],
		["close", record.close],
		["baseVolume", record.baseVolume],
		["quoteVolume", record.quoteVolume],
		["change", record.change],
		["percentage", record.percentage],
	];
	for (const [key, rawValue] of fields) {
		const numeric = toNumber(rawValue);
		if (numeric !== undefined) {
			parsed[key] = numeric;
		}
	}
	return parsed;
}
