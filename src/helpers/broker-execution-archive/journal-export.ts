import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { log } from "../logger";

const EXPORT_CHUNK_BYTES = 8 * 1024 * 1024;
const SHA256_RECEIPT_PATTERN = /^([0-9a-f]{64}) {2}(.+)\n$/;

export class DeadLetterJournalExportError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DeadLetterJournalExportError";
	}
}

export type DeadLetterJournalExportResult =
	| { status: "disabled" }
	| { status: "skipped_export_exists"; exportPath: string }
	| { status: "skipped_missing_journal"; journalPath: string }
	| {
			status: "exported";
			journalPath: string;
			exportPath: string;
			bytes: number;
			sha256: string;
	  };

// In SGX production the loss journal lives on a Gramine encrypted mount, so
// its host-side bytes are MRSIGNER-sealed ciphertext no external tool can
// read. The enclave is the only place the plaintext is visible, which makes
// the broker itself the only possible exporter: replay
// (services/archive-forwarder/scripts/archive-loss-replay.ts) runs outside and
// needs a plaintext copy on an untrusted mount. The export is a boot-time
// snapshot: losses journaled after startup are not in the copy and need a fresh
// export.
export function exportDeadLetterJournalFromEnv(): DeadLetterJournalExportResult {
	const exportPath =
		process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_EXPORT_PATH?.trim();
	if (!exportPath) {
		return { status: "disabled" };
	}
	const journalPath = process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH?.trim();
	if (!journalPath) {
		throw new DeadLetterJournalExportError(
			"CEX_BROKER_ARCHIVE_DEAD_LETTER_EXPORT_PATH is set but CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH is missing",
		);
	}
	return exportDeadLetterJournal(journalPath, exportPath);
}

export function exportDeadLetterJournal(
	journalPath: string,
	exportPath: string,
): DeadLetterJournalExportResult {
	const receiptPath = `${exportPath}.sha256`;
	// One-shot: an existing target is only a completed prior export when its
	// atomically published receipt is present and well formed. Overwriting it on
	// every boot would race the replay run reading it, so an incomplete pair
	// fails closed and requires explicit operator cleanup.
	if (existsSync(exportPath)) {
		try {
			if (!lstatSync(exportPath).isFile()) {
				throw new Error("export target is not a regular file");
			}
			if (!lstatSync(receiptPath).isFile()) {
				throw new Error("export receipt is not a regular file");
			}
			const receipt = readFileSync(receiptPath, "utf8");
			const match = SHA256_RECEIPT_PATTERN.exec(receipt);
			if (match?.[1] === undefined || match[2] !== basename(exportPath)) {
				throw new Error("export receipt is malformed");
			}
		} catch (error) {
			throw new DeadLetterJournalExportError(
				"Dead-letter journal export target is incomplete or unverifiable",
				{ cause: error },
			);
		}
		log.info("Dead-letter journal export target already exists, skipping", {
			export_path: exportPath,
		});
		return { status: "skipped_export_exists", exportPath };
	}
	if (!existsSync(journalPath)) {
		log.warn(
			"Dead-letter journal export requested but no journal exists, skipping",
			{ journal_path: journalPath },
		);
		return { status: "skipped_missing_journal", journalPath };
	}

	const temporarySuffix = `${process.pid}.${randomUUID()}.partial`;
	const partialPath = `${exportPath}.${temporarySuffix}`;
	const receiptPartialPath = `${receiptPath}.${temporarySuffix}`;
	let bytes = 0;
	let digest: string;
	try {
		const hash = createHash("sha256");
		const sourceFd = openSync(journalPath, "r");
		try {
			const targetFd = openSync(partialPath, "wx", 0o600);
			try {
				const chunk = Buffer.alloc(EXPORT_CHUNK_BYTES);
				for (;;) {
					const read = readSync(sourceFd, chunk, 0, chunk.length, null);
					if (read === 0) {
						break;
					}
					const view = chunk.subarray(0, read);
					hash.update(view);
					writeFileSync(targetFd, view);
					bytes += read;
				}
				fsyncSync(targetFd);
			} finally {
				closeSync(targetFd);
			}
		} finally {
			closeSync(sourceFd);
		}
		digest = hash.digest("hex");
		const receiptFd = openSync(receiptPartialPath, "wx", 0o600);
		try {
			writeFileSync(receiptFd, `${digest}  ${basename(exportPath)}\n`);
			fsyncSync(receiptFd);
		} finally {
			closeSync(receiptFd);
		}
		// Publish the receipt last so it acts as the completion marker. A crash or
		// rename failure between these operations leaves an export without a valid
		// receipt, which the next startup rejects instead of silently skipping.
		renameSync(partialPath, exportPath);
		renameSync(receiptPartialPath, receiptPath);
		const parentFd = openSync(dirname(exportPath), "r");
		try {
			fsyncSync(parentFd);
		} finally {
			closeSync(parentFd);
		}
	} catch (error) {
		for (const temporaryPath of [partialPath, receiptPartialPath]) {
			try {
				unlinkSync(temporaryPath);
			} catch {}
		}
		// The operator explicitly asked for this export; a partial or unverifiable
		// copy silently left in place would defeat its purpose, so startup fails.
		throw new DeadLetterJournalExportError(
			"Dead-letter journal export failed",
			{ cause: error },
		);
	}

	log.info("Dead-letter journal exported", {
		journal_path: journalPath,
		export_path: exportPath,
		bytes,
		sha256: digest,
	});
	return {
		status: "exported",
		journalPath,
		exportPath,
		bytes,
		sha256: digest,
	};
}
