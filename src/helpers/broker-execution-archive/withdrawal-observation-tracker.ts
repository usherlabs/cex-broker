import { asRecord } from "../shared/guards";
import type { NormalizedCcxtTransfer } from "./rows";

export const DEFAULT_WITHDRAWAL_OBSERVATION_TRACKER_MAX_ENTRIES = 10_000;

const VENUE_LIFECYCLE_EVIDENCE_FIELDS = [
	"updated",
	"updatedAt",
	"updated_at",
	"updateTime",
	"update_time",
	"updateTimestamp",
	"lastUpdateTimestamp",
	"completed",
	"completedAt",
	"completed_at",
	"completeTime",
	"complete_time",
	"completionTime",
	"successTime",
] as const;

type WithdrawalObservation = {
	exchange: string;
	accountSelector?: string;
	assetSymbol?: string;
	transaction: unknown;
	normalized: NormalizedCcxtTransfer;
};

function fingerprintEvidenceValue(value: unknown): unknown {
	if (value === undefined || value === null) {
		return value;
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function venueLifecycleEvidence(transaction: unknown): unknown[] {
	const record = asRecord(transaction);
	const info = asRecord(record?.info);
	const evidence: unknown[] = [];
	for (const [scope, source] of [
		["transaction", record],
		["info", info],
	] as const) {
		for (const field of VENUE_LIFECYCLE_EVIDENCE_FIELDS) {
			const value = source?.[field];
			if (value !== undefined && value !== null) {
				evidence.push([scope, field, fingerprintEvidenceValue(value)]);
			}
		}
	}
	return evidence;
}

function observationFingerprint(observation: WithdrawalObservation): string {
	const { normalized, transaction } = observation;
	return JSON.stringify({
		status: normalized.status ?? null,
		txid: normalized.txid ?? null,
		amount: normalized.amount ?? null,
		feeAmount: normalized.feeAmount ?? null,
		feeCurrency: normalized.feeCurrency ?? null,
		exchangeTimestamp: normalized.exchangeTimestamp ?? null,
		venueLifecycleEvidence: venueLifecycleEvidence(transaction),
	});
}

/**
 * Suppresses unchanged withdrawal-history observations within one broker process.
 * The tracker intentionally persists no state: restart replay is absorbed by
 * archive consumers, while the in-process bound prevents unbounded venue history.
 */
export class WithdrawalObservationTracker {
	readonly #fingerprints = new Map<string, string>();
	readonly #maxEntries: number;
	#missingIdSequence = 0n;

	constructor(options?: { maxEntries?: number }) {
		this.#maxEntries = Math.max(
			1,
			Math.floor(
				options?.maxEntries ??
					DEFAULT_WITHDRAWAL_OBSERVATION_TRACKER_MAX_ENTRIES,
			),
		);
	}

	shouldArchive(observation: WithdrawalObservation): boolean {
		const externalId = observation.normalized.externalId?.trim();
		// Without a venue identity, a one-use process sequence is safer than
		// suppressing two distinct withdrawals that happen to share the same fields.
		const identity = JSON.stringify([
			observation.exchange.trim().toLowerCase() || "unknown",
			observation.accountSelector?.trim() || "unknown",
			observation.assetSymbol?.trim().toUpperCase() || "unknown",
			externalId || `missing:${++this.#missingIdSequence}`,
		]);
		const fingerprint = observationFingerprint(observation);
		if (this.#fingerprints.get(identity) === fingerprint) {
			return false;
		}

		// Refresh changed entries so deterministic oldest-first eviction reflects the
		// latest meaningful observation, not the first time an id was encountered.
		this.#fingerprints.delete(identity);
		this.#fingerprints.set(identity, fingerprint);
		while (this.#fingerprints.size > this.#maxEntries) {
			const oldest = this.#fingerprints.keys().next().value;
			if (oldest === undefined) break;
			this.#fingerprints.delete(oldest);
		}
		return true;
	}

	getSize(): number {
		return this.#fingerprints.size;
	}
}
