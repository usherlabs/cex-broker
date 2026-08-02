const DEFAULT_OHLCV_BOOTSTRAP_LIMIT = 100;
const MAX_OHLCV_BOOTSTRAP_LIMIT = 1_000;

export function resolveOhlcvBootstrapLimit(
	optionValue: string | undefined,
): number {
	const raw =
		optionValue?.trim() ||
		process.env.CEX_BROKER_OHLCV_ARCHIVE_BOOTSTRAP_LIMIT?.trim();
	if (raw === "0" || raw?.toLowerCase() === "false") {
		return 0;
	}
	if (!raw) {
		return DEFAULT_OHLCV_BOOTSTRAP_LIMIT;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_OHLCV_BOOTSTRAP_LIMIT;
	}
	return Math.min(parsed, MAX_OHLCV_BOOTSTRAP_LIMIT);
}
