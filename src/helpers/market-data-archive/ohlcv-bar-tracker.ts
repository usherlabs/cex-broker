import type { OhlcvArchiveCandidate, ParsedOhlcvBar } from "./types";

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function parseOhlcvBar(value: unknown): ParsedOhlcvBar | null {
	if (!Array.isArray(value) || value.length < 6) {
		return null;
	}
	const [openTimeMs, open, high, low, close, volume, quoteVolume] = value;
	if (
		!isFiniteNumber(openTimeMs) ||
		!isFiniteNumber(open) ||
		!isFiniteNumber(high) ||
		!isFiniteNumber(low) ||
		!isFiniteNumber(close) ||
		!isFiniteNumber(volume)
	) {
		return null;
	}
	const bar: ParsedOhlcvBar = {
		openTimeMs,
		open,
		high,
		low,
		close,
		volume,
	};
	if (isFiniteNumber(quoteVolume)) {
		bar.quoteVolume = quoteVolume;
	}
	return bar;
}

export function extractOhlcvBars(payload: unknown): ParsedOhlcvBar[] {
	if (!Array.isArray(payload) || payload.length === 0) {
		return [];
	}

	const rawBars = Array.isArray(payload[0]) ? payload : [payload];
	const byOpenTime = new Map<number, ParsedOhlcvBar>();
	for (const entry of rawBars) {
		const bar = parseOhlcvBar(entry);
		if (bar) {
			byOpenTime.set(bar.openTimeMs, bar);
		}
	}

	return [...byOpenTime.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export function extractLatestOhlcvBar(payload: unknown): ParsedOhlcvBar | null {
	const bars = extractOhlcvBars(payload);
	return bars[bars.length - 1] ?? null;
}

export class OhlcvBarTracker {
	private lastOpenTimeMs: number | null = null;
	private lastBar: ParsedOhlcvBar | null = null;

	process(payload: unknown, brokerVersion: number): OhlcvArchiveCandidate[] {
		const bars = extractOhlcvBars(payload);
		if (bars.length === 0) {
			return [];
		}
		if (bars.length === 1) {
			const [bar] = bars;
			return bar ? this.processSingleBar(bar, brokerVersion) : [];
		}
		return this.processBatch(bars, brokerVersion);
	}

	private processSingleBar(
		currentBar: ParsedOhlcvBar,
		brokerVersion: number,
	): OhlcvArchiveCandidate[] {
		if (
			this.lastOpenTimeMs !== null &&
			currentBar.openTimeMs < this.lastOpenTimeMs
		) {
			return [];
		}

		const candidates: OhlcvArchiveCandidate[] = [];

		if (
			this.lastOpenTimeMs !== null &&
			this.lastBar !== null &&
			currentBar.openTimeMs !== this.lastOpenTimeMs
		) {
			candidates.push({
				bar: this.lastBar,
				isClosed: true,
				brokerVersion,
			});
		}

		candidates.push({
			bar: currentBar,
			isClosed: false,
			brokerVersion,
		});

		this.lastOpenTimeMs = currentBar.openTimeMs;
		this.lastBar = currentBar;
		return candidates;
	}

	private processBatch(
		bars: ParsedOhlcvBar[],
		brokerVersion: number,
	): OhlcvArchiveCandidate[] {
		const firstBar = bars[0];
		const lastBar = bars[bars.length - 1];
		if (!firstBar || !lastBar) {
			return [];
		}

		if (
			this.lastOpenTimeMs !== null &&
			lastBar.openTimeMs < this.lastOpenTimeMs
		) {
			return [];
		}

		const candidates: OhlcvArchiveCandidate[] = [];

		if (
			this.lastBar !== null &&
			this.lastOpenTimeMs !== null &&
			!bars.some((bar) => bar.openTimeMs === this.lastOpenTimeMs) &&
			this.lastOpenTimeMs < firstBar.openTimeMs
		) {
			candidates.push({
				bar: this.lastBar,
				isClosed: true,
				brokerVersion,
			});
		}

		for (let index = 0; index < bars.length - 1; index += 1) {
			const bar = bars[index];
			if (bar) {
				candidates.push({
					bar,
					isClosed: true,
					brokerVersion,
				});
			}
		}

		candidates.push({
			bar: lastBar,
			isClosed: false,
			brokerVersion,
		});

		this.lastOpenTimeMs = lastBar.openTimeMs;
		this.lastBar = lastBar;
		return candidates;
	}
}
