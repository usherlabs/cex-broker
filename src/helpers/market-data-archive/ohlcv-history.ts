import type { Exchange } from "@usherlabs/ccxt";
import { log } from "../logger";
import type { OtelMetrics } from "../otel";
import type { BrokerExecutionArchiver } from "../broker-execution-archive/writer";
import { archiveOhlcvInBackground } from "./capture";
import type { OhlcvBarTracker } from "./ohlcv-bar-tracker";
import { resolveOhlcvBootstrapLimit } from "./ohlcv-bootstrap";
import type { OhlcvArchiveInput } from "./types";

function supportsFetchOhlcv(broker: Exchange): boolean {
	const fetchOHLCV = (broker as unknown as { fetchOHLCV?: unknown }).fetchOHLCV;
	const hasValue = (broker.has as Record<string, unknown> | undefined)
		?.fetchOHLCV;
	return typeof fetchOHLCV === "function" && hasValue !== false;
}

export async function bootstrapOhlcvHistory(
	broker: Exchange,
	archiver: BrokerExecutionArchiver | undefined,
	otelMetrics: OtelMetrics | undefined,
	tracker: OhlcvBarTracker,
	input: OhlcvArchiveInput,
	options?: {
		bootstrapLimit?: string;
	},
): Promise<unknown | null> {
	const limit = resolveOhlcvBootstrapLimit(options?.bootstrapLimit);
	if (limit <= 0 || !supportsFetchOhlcv(broker)) {
		return null;
	}

	try {
		const fetchOHLCV = broker.fetchOHLCV.bind(broker);
		const payload = await fetchOHLCV(
			input.symbol,
			input.timeframe ?? "1m",
			undefined,
			limit,
		);
		if (!Array.isArray(payload) || payload.length === 0) {
			return null;
		}

		const receivedTimestamp = Date.now();
		archiveOhlcvInBackground(archiver, otelMetrics, tracker, {
			...input,
			payload,
			receivedTimestamp,
		});
		return payload;
	} catch (error) {
		log.warn("OHLCV bootstrap fetch failed", {
			error,
			symbol: input.symbol,
			exchange: input.exchange,
			timeframe: input.timeframe,
		});
		return null;
	}
}
