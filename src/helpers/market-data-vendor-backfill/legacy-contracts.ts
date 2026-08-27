/**
 * Historical result-v1 codec retained only to validate immutable old evidence.
 * Current executables and package entry points must never import this module.
 */
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import {
	archiveSelectionCodec,
	type BackfillOutcomeWire,
	type FixedUtcTimestamp,
	type LowercaseUuid,
	promotionReceiptCodec,
	type Sha256Hex,
} from "./contracts";
import { assertDocumentSha256, documentSha256 } from "./identity";
import archiveSelectionSchema from "./schemas/archive-selection.schema.json" with {
	type: "json",
};
import promotionReceiptSchema from "./schemas/promotion-receipt.schema.json" with {
	type: "json",
};
import resultSchema from "./schemas/result.schema.json" with { type: "json" };

export const BACKFILL_RESULT_SCHEMA_ID = resultSchema.$id;

export type BackfillJobResultWire = {
	schema_id: typeof BACKFILL_RESULT_SCHEMA_ID;
	result_sha256: Sha256Hex;
	job_id: LowercaseUuid;
	request_file_sha256: Sha256Hex | null;
	executable_sha256: Sha256Hex;
	schema_manifest_sha256: Sha256Hex;
	cex_package: {
		name: "@usherlabs/cex-broker";
		version: string;
		package_sha256: Sha256Hex;
	};
	capability_policy: { policy_id: string; policy_sha256: Sha256Hex };
	resource_policy: { policy_id: string; policy_sha256: Sha256Hex };
	build: { fiet_tee_commit: string; created_at: FixedUtcTimestamp };
	started_at: FixedUtcTimestamp;
	completed_at: FixedUtcTimestamp;
	outcome: BackfillOutcomeWire;
};

function describeAjvErrors(errors: ErrorObject[] | null | undefined): string {
	return (errors ?? [])
		.map(
			(error) =>
				`${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
		)
		.join("; ");
}

function fixedTimestampMs(value: string, field: string): number {
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		new Date(parsed).toISOString() !== value
	) {
		throw new Error(`${field} is not a fixed UTC RFC3339 timestamp`);
	}
	return parsed;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(archiveSelectionSchema);
ajv.addSchema(promotionReceiptSchema);
const validateBackfillResult = ajv.compile(resultSchema);

export const backfillResultCodec = {
	decode(value: unknown): BackfillJobResultWire {
		if (!validateBackfillResult(value)) {
			throw new Error(
				`JSON Schema validation failed: ${describeAjvErrors(validateBackfillResult.errors)}`,
			);
		}
		const result = value as BackfillJobResultWire;
		assertDocumentSha256(result, "result_sha256");
		if (
			fixedTimestampMs(result.completed_at, "completed_at") <
			fixedTimestampMs(result.started_at, "started_at")
		) {
			throw new Error("completed_at precedes started_at");
		}
		if (result.outcome.selection) {
			archiveSelectionCodec.decode(result.outcome.selection);
		}
		if (result.outcome.receipt) {
			promotionReceiptCodec.decode(result.outcome.receipt);
		}
		if (
			result.outcome.status === "promoted" &&
			(!result.outcome.selection || !result.outcome.receipt)
		) {
			throw new Error("promoted outcome requires selection and receipt");
		}
		if (
			result.outcome.status === "already_covered" &&
			!result.outcome.selection
		) {
			throw new Error("already_covered outcome requires selection");
		}
		return result;
	},
	is(value: unknown): value is BackfillJobResultWire {
		try {
			this.decode(value);
			return true;
		} catch {
			return false;
		}
	},
};

export function finalizeBackfillResult(
	result: Omit<BackfillJobResultWire, "result_sha256"> &
		Partial<Pick<BackfillJobResultWire, "result_sha256">>,
): BackfillJobResultWire {
	const { result_sha256: _resultSha256, ...content } = result;
	return backfillResultCodec.decode({
		...content,
		result_sha256: documentSha256(content, "result_sha256"),
	});
}
