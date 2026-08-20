import type {
	BackfillArchiveRow,
	FixedUtcTimestamp,
	Sha256Hex,
} from "./contracts";
import { jcsCanonicalize, jcsSha256 } from "./identity";

export type QualificationEvent = {
	qualification_event_id: string;
	capture_bundle_id: Sha256Hex;
	state: "qualified" | "quarantined" | "revoked";
	receipt_id: Sha256Hex;
	promotion_identity_sha256: Sha256Hex;
	window: { start_at: FixedUtcTimestamp; end_at: FixedUtcTimestamp };
	event_at: FixedUtcTimestamp;
	reason_code: string;
};

type UnfinalizedQualificationEvent = Omit<
	QualificationEvent,
	"qualification_event_id"
> &
	Partial<Pick<QualificationEvent, "qualification_event_id">>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REASON = /^[a-z][a-z0-9_]{0,127}$/;
const EVENT_FIELDS = new Set([
	"qualification_event_id",
	"capture_bundle_id",
	"state",
	"receipt_id",
	"promotion_identity_sha256",
	"window",
	"event_at",
	"reason_code",
]);

function deterministicUuid(value: unknown): string {
	const digest = jcsSha256(value).slice(0, 32).split("");
	digest[12] = "5";
	digest[16] = "8";
	const hex = digest.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function semanticEvent(
	event: UnfinalizedQualificationEvent,
): Omit<QualificationEvent, "qualification_event_id"> {
	const { qualification_event_id: _eventId, ...semantic } = event;
	return semantic;
}

function assertTimestamp(value: string, field: string): number {
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		new Date(parsed).toISOString() !== value
	) {
		throw new Error(`${field} must be a fixed UTC RFC3339 timestamp`);
	}
	return parsed;
}

export function parseQualificationEvent(value: unknown): QualificationEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("qualification event must be an object");
	}
	const event = value as QualificationEvent;
	if (
		Object.keys(event).length !== EVENT_FIELDS.size ||
		!Object.keys(event).every((field) => EVENT_FIELDS.has(field)) ||
		!UUID.test(event.qualification_event_id) ||
		!SHA256.test(event.capture_bundle_id) ||
		!["qualified", "quarantined", "revoked"].includes(event.state) ||
		!SHA256.test(event.receipt_id) ||
		!SHA256.test(event.promotion_identity_sha256) ||
		!event.window ||
		typeof event.window !== "object" ||
		Object.keys(event.window).length !== 2 ||
		!REASON.test(event.reason_code)
	) {
		throw new Error("qualification event fields are invalid");
	}
	if (
		assertTimestamp(event.window.end_at, "window.end_at") <=
		assertTimestamp(event.window.start_at, "window.start_at")
	) {
		throw new Error("qualification window must be increasing");
	}
	assertTimestamp(event.event_at, "event_at");
	if (
		deterministicUuid(semanticEvent(event)) !== event.qualification_event_id
	) {
		throw new Error("qualification_event_id does not match event content");
	}
	return event;
}

export function finalizeQualificationEvent(
	event: UnfinalizedQualificationEvent,
): QualificationEvent {
	const semantic = semanticEvent(event);
	return parseQualificationEvent({
		...semantic,
		qualification_event_id: deterministicUuid(semantic),
	});
}

export function qualificationEventToArchiveRow(
	eventInput: QualificationEvent,
): BackfillArchiveRow {
	const event = parseQualificationEvent(eventInput);
	return {
		table: "market_data.cex_order_book_capture_qualifications",
		row: {
			source: "external_backfill",
			capture_origin: "vendor_historical_backfill",
			source_mode: "vendor_historical_backfill_v1",
			deployment_id: "market-data-vendor-backfill",
			qualification_event_id: event.qualification_event_id,
			capture_bundle_id: event.capture_bundle_id,
			state: event.state,
			receipt_id: event.receipt_id,
			promotion_identity_sha256: event.promotion_identity_sha256,
			window_start_ms: Date.parse(event.window.start_at),
			window_end_ms: Date.parse(event.window.end_at),
			event_at_ms: Date.parse(event.event_at),
			reason_code: event.reason_code,
			event_json: jcsCanonicalize(event),
		},
	};
}

export function qualificationEventFromArchiveRow(
	row: Record<string, unknown>,
): QualificationEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(row.event_json));
	} catch {
		throw new Error("qualification event_json is invalid");
	}
	const event = parseQualificationEvent(parsed);
	if (
		row.source !== "external_backfill" ||
		row.capture_origin !== "vendor_historical_backfill" ||
		row.source_mode !== "vendor_historical_backfill_v1" ||
		row.deployment_id !== "market-data-vendor-backfill" ||
		row.qualification_event_id !== event.qualification_event_id ||
		row.capture_bundle_id !== event.capture_bundle_id ||
		row.state !== event.state ||
		row.receipt_id !== event.receipt_id ||
		row.promotion_identity_sha256 !== event.promotion_identity_sha256 ||
		row.window_start_ms !== Date.parse(event.window.start_at) ||
		row.window_end_ms !== Date.parse(event.window.end_at) ||
		row.event_at_ms !== Date.parse(event.event_at) ||
		row.reason_code !== event.reason_code
	) {
		throw new Error("qualification archive row does not match event JSON");
	}
	return event;
}
