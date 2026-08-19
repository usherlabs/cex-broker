import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DeadLetterJournalExportError,
	exportDeadLetterJournal,
	exportDeadLetterJournalFromEnv,
} from "../src/helpers/broker-execution-archive/journal-export";

const JOURNAL_CONTENT = `${JSON.stringify({
	timestamp: "2026-08-18T12:00:00.000Z",
	source: "cex-broker",
	deployment_id: "test",
	reason: "shed_queue_overflow",
	payload: { table: "broker_execution.order_events", row: { order_id: "1" } },
})}\n`;

const JOURNAL_SHA256 = new Bun.CryptoHasher("sha256")
	.update(JOURNAL_CONTENT)
	.digest("hex");

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "journal-export-"));
	cleanupDirs.push(dir);
	return dir;
}

const cleanupDirs: string[] = [];

afterEach(() => {
	for (const dir of cleanupDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_EXPORT_PATH;
});

describe("exportDeadLetterJournal", () => {
	test("copies the journal byte-for-byte and writes a matching sha256 receipt", () => {
		const dir = makeDir();
		const journalPath = join(dir, "archive-dead-letter.jsonl");
		const exportPath = join(dir, "exported.jsonl");
		writeFileSync(journalPath, JOURNAL_CONTENT);

		const result = exportDeadLetterJournal(journalPath, exportPath);

		expect(result.status).toBe("exported");
		if (result.status !== "exported") throw new Error("unreachable");
		expect(result.bytes).toBe(Buffer.byteLength(JOURNAL_CONTENT));
		expect(result.sha256).toBe(JOURNAL_SHA256);
		expect(readFileSync(exportPath, "utf8")).toBe(JOURNAL_CONTENT);
		expect(readFileSync(`${exportPath}.sha256`, "utf8")).toBe(
			`${JOURNAL_SHA256}  exported.jsonl\n`,
		);
		expect(existsSync(`${exportPath}.partial`)).toBe(false);
	});

	test("skips without touching an existing export target", () => {
		const dir = makeDir();
		const journalPath = join(dir, "archive-dead-letter.jsonl");
		const exportPath = join(dir, "exported.jsonl");
		writeFileSync(journalPath, JOURNAL_CONTENT);
		writeFileSync(exportPath, "prior export the operator has not consumed");

		const result = exportDeadLetterJournal(journalPath, exportPath);

		expect(result.status).toBe("skipped_export_exists");
		expect(readFileSync(exportPath, "utf8")).toBe(
			"prior export the operator has not consumed",
		);
		expect(existsSync(`${exportPath}.sha256`)).toBe(false);
	});

	test("skips when no journal exists and creates nothing", () => {
		const dir = makeDir();
		const journalPath = join(dir, "archive-dead-letter.jsonl");
		const exportPath = join(dir, "exported.jsonl");

		const result = exportDeadLetterJournal(journalPath, exportPath);

		expect(result.status).toBe("skipped_missing_journal");
		expect(existsSync(exportPath)).toBe(false);
		expect(existsSync(`${exportPath}.sha256`)).toBe(false);
	});

	test("fails loudly when the export target cannot be written", () => {
		const dir = makeDir();
		const journalPath = join(dir, "archive-dead-letter.jsonl");
		writeFileSync(journalPath, JOURNAL_CONTENT);

		expect(() =>
			exportDeadLetterJournal(
				journalPath,
				join(dir, "missing-subdir", "exported.jsonl"),
			),
		).toThrow(DeadLetterJournalExportError);
	});
});

describe("exportDeadLetterJournalFromEnv", () => {
	test("is a no-op without the export env var", () => {
		expect(exportDeadLetterJournalFromEnv()).toEqual({ status: "disabled" });
	});

	test("throws when export is requested but no journal path is configured", () => {
		const dir = makeDir();
		process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_EXPORT_PATH = join(
			dir,
			"exported.jsonl",
		);
		const previous = process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH;
		delete process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH;
		try {
			expect(() => exportDeadLetterJournalFromEnv()).toThrow(
				DeadLetterJournalExportError,
			);
		} finally {
			if (previous !== undefined) {
				process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH = previous;
			}
		}
	});
});
