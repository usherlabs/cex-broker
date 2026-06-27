import type { Exchange } from "@usherlabs/ccxt";
import { log } from "../logger";
import {
	buildOrderExecutionTelemetry,
	type OrderTelemetryAction,
	type OrderTelemetryContext,
} from "../order-telemetry";
import { asRecord } from "../shared/guards";
import {
	buildCommonArchiveTags,
	buildMarketMetadataSnapshotRow,
	buildOrderEventArchiveRow,
	buildSubscribeStreamArchiveRow,
} from "./rows";
import type { SubscribeArchiveType } from "./types";
import type { BrokerExecutionArchiver } from "./writer";

export function archiveOrderExecutionInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	context: OrderTelemetryContext,
	order: unknown,
	error?: unknown,
	options?: {
		marketMetadataHash?: string;
	},
): void {
	if (!archiver?.isEnabled()) {
		return;
	}
	queueMicrotask(() => {
		try {
			const telemetry = buildOrderExecutionTelemetry(context, order, error);
			const tags = buildCommonArchiveTags({
				deploymentId: archiver.getDeploymentId(),
				accountSelector: context.accountLabel,
				exchange: context.cex,
				symbol: telemetry.symbol,
				brokerObservedTimestamp: telemetry.brokerObservedTimestamp,
			});
			archiver.enqueue(
				buildOrderEventArchiveRow({
					tags,
					action: context.action,
					telemetry,
					marketMetadataHash: options?.marketMetadataHash,
				}),
			);
		} catch (archiveError) {
			log.warn("Failed to archive order execution", { error: archiveError });
		}
	});
}

export function archiveSubscribeStreamInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	input: {
		exchange: string;
		accountSelector?: string;
		symbol: string;
		subscriptionType: SubscribeArchiveType;
		streamPayload: unknown;
		secretLiterals?: readonly string[];
	},
): void {
	if (!archiver?.isEnabled()) {
		return;
	}
	queueMicrotask(() => {
		try {
			const tags = buildCommonArchiveTags({
				deploymentId: archiver.getDeploymentId(),
				accountSelector: input.accountSelector,
				exchange: input.exchange,
				symbol: input.symbol,
			});
			archiver.enqueue(
				buildSubscribeStreamArchiveRow({
					tags,
					subscriptionType: input.subscriptionType,
					streamPayload: input.streamPayload,
					secretLiterals: input.secretLiterals,
				}),
			);
		} catch (archiveError) {
			log.warn("Failed to archive subscribe stream event", {
				error: archiveError,
			});
		}
	});
}

export async function captureMarketMetadataSnapshot(
	archiver: BrokerExecutionArchiver | undefined,
	broker: Exchange,
	input: {
		exchange: string;
		accountSelector?: string;
		symbol: string;
		action: OrderTelemetryAction;
		clientOrderId?: string;
		orderId?: string;
		makerActionId?: string;
		idempotencyId?: string;
		brokerObservedTimestamp?: string;
	},
): Promise<string | undefined> {
	if (!archiver?.isEnabled()) {
		return undefined;
	}
	try {
		const fetchOrderBook = (
			broker as unknown as {
				fetchOrderBook?: (symbol: string, limit?: number) => Promise<unknown>;
			}
		).fetchOrderBook;
		if (typeof fetchOrderBook !== "function") {
			return undefined;
		}
		const orderBook = await fetchOrderBook.call(broker, input.symbol, 5);
		const record = asRecord(orderBook);
		const snapshot = {
			action: input.action,
			symbol: input.symbol,
			bids: record?.bids,
			asks: record?.asks,
			timestamp: record?.timestamp ?? Date.now(),
			datetime: record?.datetime,
			nonce: record?.nonce,
		};
		const tags = buildCommonArchiveTags({
			deploymentId: archiver.getDeploymentId(),
			accountSelector: input.accountSelector,
			exchange: input.exchange,
			symbol: input.symbol,
			brokerObservedTimestamp: input.brokerObservedTimestamp,
		});
		const row = buildMarketMetadataSnapshotRow({
			tags,
			clientOrderId: input.clientOrderId,
			orderId: input.orderId,
			makerActionId: input.makerActionId,
			idempotencyId: input.idempotencyId,
			marketSnapshot: snapshot,
		});
		archiver.enqueue(row);
		const hash = row.row.market_metadata_hash;
		return typeof hash === "string" ? hash : undefined;
	} catch (archiveError) {
		log.warn("Failed to capture market metadata snapshot", {
			error: archiveError,
		});
		return undefined;
	}
}

export function captureMarketMetadataSnapshotInBackground(
	archiver: BrokerExecutionArchiver | undefined,
	broker: Exchange,
	input: Parameters<typeof captureMarketMetadataSnapshot>[2],
): void {
	void captureMarketMetadataSnapshot(archiver, broker, input);
}
