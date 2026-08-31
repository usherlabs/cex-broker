const DEFAULT_ORDERBOOK_ARCHIVE_DEPTH_LIMIT = 25;
const MAX_ORDERBOOK_ARCHIVE_DEPTH_LIMIT = 500;
export const MAX_ORDERBOOK_MEASUREMENT_BANDS = 64;
export const MAX_ORDERBOOK_MEASUREMENT_BAND_BPS = 10_000;
const DEFAULT_ORDERBOOK_MEASUREMENT_BANDS_BPS = [10, 25, 50, 100] as const;

function parseBoundedDepth(raw: string, field: string): number {
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(`${field} must be an integer between 1 and 500`);
	}
	const parsed = Number(raw);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed > MAX_ORDERBOOK_ARCHIVE_DEPTH_LIMIT
	) {
		throw new Error(`${field} must be an integer between 1 and 500`);
	}
	return parsed;
}

export function getOrderbookArchiveDepthLimit(): number {
	const raw = process.env.CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT?.trim();
	if (!raw) {
		return DEFAULT_ORDERBOOK_ARCHIVE_DEPTH_LIMIT;
	}
	return parseBoundedDepth(raw, "CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT");
}

export function normalizeOrderbookMeasurementBandsBps(
	input: readonly number[] | undefined,
): number[] {
	const bands = input ?? DEFAULT_ORDERBOOK_MEASUREMENT_BANDS_BPS;
	if (bands.length === 0) {
		throw new Error("ORDERBOOK measurement bands must not be empty");
	}
	for (const band of bands) {
		if (
			!Number.isSafeInteger(band) ||
			band <= 0 ||
			band > MAX_ORDERBOOK_MEASUREMENT_BAND_BPS
		) {
			throw new Error(
				"ORDERBOOK measurement bands must be integer basis points in 1..10000",
			);
		}
	}
	const normalized = [...new Set(bands)].sort((left, right) => left - right);
	if (normalized.length > MAX_ORDERBOOK_MEASUREMENT_BANDS) {
		throw new Error(
			`ORDERBOOK measurement bands must contain at most ${MAX_ORDERBOOK_MEASUREMENT_BANDS} unique entries`,
		);
	}
	return normalized;
}

export function getOrderbookMeasurementBandsBps(): number[] {
	const raw = process.env.CEX_BROKER_ORDERBOOK_MEASUREMENT_BANDS_BPS?.trim();
	if (!raw) {
		return [...DEFAULT_ORDERBOOK_MEASUREMENT_BANDS_BPS];
	}
	const parts = raw.split(",").map((entry) => entry.trim());
	if (parts.some((entry) => !/^[1-9]\d*$/.test(entry))) {
		throw new Error(
			"CEX_BROKER_ORDERBOOK_MEASUREMENT_BANDS_BPS must be a comma-separated list of positive integers",
		);
	}
	return normalizeOrderbookMeasurementBandsBps(parts.map(Number));
}

export function splitOrderBookSide(
	levels: number[][],
	limit: number,
): { prices: number[]; sizes: number[] } {
	const prices: number[] = [];
	const sizes: number[] = [];
	for (const level of levels.slice(0, limit)) {
		if (!Array.isArray(level) || level.length < 2) {
			continue;
		}
		const price = level[0];
		const size = level[1];
		if (
			price === undefined ||
			size === undefined ||
			!Number.isFinite(price) ||
			!Number.isFinite(size)
		) {
			continue;
		}
		prices.push(price);
		sizes.push(size);
	}
	return { prices, sizes };
}
