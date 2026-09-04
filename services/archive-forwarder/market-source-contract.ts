import type { ArchiveBatchRequest } from "./types";

const BROKER_MARKET_SOURCES = new Set(["broker_read", "broker_write"]);

export function isMarketArchiveTable(table: unknown): boolean {
	return typeof table === "string" && table.startsWith("market_data.");
}

export type MarketSourceClassification =
	| "not_market"
	| "broker_market"
	| "invalid_market_source";

/**
 * Market archive ownership is deployment-derived and closed to the two broker
 * roles. Strategy and stream-health envelopes retain their independent source
 * contracts and are deliberately ignored here.
 */
export function classifyMarketSource(
	value: unknown,
	expected?: { source: "broker_read" | "broker_write"; deploymentId: string },
): MarketSourceClassification {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return "not_market";
	}
	const envelope = value as Partial<ArchiveBatchRequest>;
	if (!Array.isArray(envelope.rows)) {
		return "not_market";
	}
	const marketRows = envelope.rows.filter((entry) =>
		isMarketArchiveTable(entry?.table),
	);
	if (marketRows.length === 0) {
		return "not_market";
	}
	if (
		expected === undefined ||
		typeof envelope.source !== "string" ||
		!BROKER_MARKET_SOURCES.has(envelope.source) ||
		envelope.source !== expected.source ||
		envelope.deployment_id !== expected.deploymentId
	) {
		return "invalid_market_source";
	}
	for (const entry of marketRows) {
		if (!entry.row || typeof entry.row !== "object" || Array.isArray(entry.row)) {
			return "invalid_market_source";
		}
		const row = entry.row as Record<string, unknown>;
		if (
			row.source !== envelope.source ||
			row.deployment_id !== expected.deploymentId
		) {
			return "invalid_market_source";
		}
	}
	return "broker_market";
}
