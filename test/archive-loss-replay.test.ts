import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	type ArchiveLossReplayResult,
	runArchiveLossReplay,
} from "../scripts/archive-loss-replay";
import { BrokerExecutionArchiver } from "../src/helpers/broker-execution-archive/writer";
import { startForwarderServer } from "./archive-forwarder-server";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function testPaths(): { journal: string; ledger: string } {
	const directory = mkdtempSync(join(tmpdir(), "archive-loss-replay-test-"));
	directories.push(directory);
	const journal = join(directory, "archive-loss.jsonl");
	return { journal, ledger: `${journal}.replay-ledger.jsonl` };
}

function lossRecord(
	lineId: string,
	options: {
		table?: string;
		batchId?: string | null;
		batchRowIndex?: number;
		batchRowCount?: number;
		reason?: "queue_shed" | "shutdown_forwarder_failure" | "retry_exhausted";
	} = {},
): Record<string, unknown> {
	return {
		timestamp: "2026-08-14T00:00:00.000Z",
		source: "broker_write",
		deployment_id: "replay-test",
		reason: options.reason ?? "queue_shed",
		payload: {
			table: options.table ?? "broker_execution.order_events",
			row: { source: "broker_write", order_id: lineId },
		},
		record_version: 1,
		batch_id: options.batchId ?? null,
		batch_row_index: options.batchRowIndex ?? 0,
		batch_row_count: options.batchRowCount ?? 1,
	};
}

function writeJournal(journal: string, records: unknown[]): void {
	writeFileSync(
		journal,
		`${records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n")}\n`,
	);
}

function postedBatchIds(
	requests: Awaited<ReturnType<typeof startForwarderServer>>["requests"],
): string[] {
	return requests.map(({ body }) => String(body.batch_id));
}

async function produceRetryExhaustedJournal(journal: string): Promise<{
	batchId: string;
	rows: unknown[];
}> {
	const failing = await startForwarderServer(() => ({ status: 503 }));
	try {
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: failing.url,
			deadLetterPath: journal,
			deploymentId: "replay-test",
			batchSize: 10,
			flushIntervalMs: 60_000,
		});
		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "original-1" },
		});
		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "original-2" },
		});
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await archiver.flush();
		}
		await archiver.close();
		expect(failing.requests).toHaveLength(10);
		const first = failing.requests[0]?.body;
		return {
			batchId: String(first?.batch_id),
			rows: first?.rows ?? [],
		};
	} finally {
		await failing.close();
	}
}

describe("archive loss replay", () => {
	test("ledger outcomes make a second replay skip every journal entry", async () => {
		const { journal, ledger } = testPaths();
		writeJournal(journal, [lossRecord("one"), lossRecord("two")]);
		const forwarder = await startForwarderServer();
		try {
			const first = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			expect(first.exitCode).toBe(0);
			expect(forwarder.requests).toHaveLength(1);

			const second = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			expect(second.exitCode).toBe(0);
			expect(forwarder.requests).toHaveLength(1);
			expect(second.summary.entries.skipped_by_ledger).toBe(2);
			expect(second.summary.batches.skipped_by_ledger).toBe(1);
		} finally {
			await forwarder.close();
		}
	});

	test("fresh batch identity is byte-identical when the ledger is deleted", async () => {
		const { journal, ledger } = testPaths();
		writeJournal(journal, [lossRecord("one"), lossRecord("two")]);
		const forwarder = await startForwarderServer();
		try {
			await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			const firstIds = postedBatchIds(forwarder.requests);
			rmSync(ledger);
			await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			const secondIds = postedBatchIds(forwarder.requests).slice(
				firstIds.length,
			);
			expect(firstIds).toEqual(secondIds);
			expect(firstIds[0]?.startsWith("replay-v1-")).toBe(true);
		} finally {
			await forwarder.close();
		}
	});

	test("a legacy record without record_version receives fresh identity", async () => {
		const { journal, ledger } = testPaths();
		const legacy = lossRecord("legacy");
		delete legacy.record_version;
		delete legacy.batch_id;
		delete legacy.batch_row_index;
		delete legacy.batch_row_count;
		writeJournal(journal, [legacy]);
		const forwarder = await startForwarderServer();
		try {
			const result = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			expect(result.exitCode).toBe(0);
			expect(String(forwarder.requests[0]?.body.batch_id)).toStartWith(
				"replay-v1-",
			);
		} finally {
			await forwarder.close();
		}
	});

	test("retry exhaustion replays the complete batch under its original identity", async () => {
		const { journal, ledger } = testPaths();
		const original = await produceRetryExhaustedJournal(journal);
		const records = readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(records).toHaveLength(2);
		expect(records.every(({ reason }) => reason === "retry_exhausted")).toBe(
			true,
		);

		const forwarder = await startForwarderServer();
		try {
			const result = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			expect(result.exitCode).toBe(0);
			expect(forwarder.requests).toHaveLength(1);
			expect(forwarder.requests[0]?.body.batch_id).toBe(original.batchId);
			expect(forwarder.requests[0]?.body.rows).toEqual(original.rows);
		} finally {
			await forwarder.close();
		}
	});

	test("an incomplete original batch is downgraded and warned about", async () => {
		const { journal, ledger } = testPaths();
		const original = await produceRetryExhaustedJournal(journal);
		const lines = readFileSync(journal, "utf8").trim().split("\n");
		writeFileSync(journal, `${lines[0]}\n`);

		const forwarder = await startForwarderServer();
		try {
			const result = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			const replayId = String(forwarder.requests[0]?.body.batch_id);
			expect(replayId).not.toBe(original.batchId);
			expect(replayId.startsWith("replay-v1-")).toBe(true);
			expect(result.summary.warnings).toEqual([
				expect.stringContaining(
					`Original batch ${original.batchId} is incomplete; missing indices: 1`,
				),
			]);
		} finally {
			await forwarder.close();
		}
	});

	test("an unparseable line remains visible while other lines replay", async () => {
		const { journal, ledger } = testPaths();
		writeJournal(journal, [lossRecord("valid"), '{"timestamp":']);
		const forwarder = await startForwarderServer();
		try {
			const result = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
				archive: true,
				brokerStopped: true,
			});
			expect(result.exitCode).toBe(1);
			expect(result.summary.lines.unparseable).toEqual([
				{ line: 2, reason: "invalid JSON" },
			]);
			expect(result.summary.entries.accepted).toBe(1);
			expect(forwarder.requests).toHaveLength(1);
			expect(result.summary.errors).toEqual([
				expect.stringContaining("--archive refused"),
			]);
			expect(existsSync(journal)).toBe(true);
		} finally {
			await forwarder.close();
		}
	});

	test("unsupported tables are terminally blocked without a POST", async () => {
		const { journal, ledger } = testPaths();
		writeJournal(journal, [
			lossRecord("unsupported", { table: "broker_execution.unknown" }),
		]);
		const forwarder = await startForwarderServer();
		try {
			const result = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			expect(result.exitCode).toBe(1);
			expect(forwarder.requests).toHaveLength(0);
			expect(result.summary.entries.blocked_unsupported_table).toBe(1);
			expect(existsSync(journal)).toBe(true);
			const ledgerRecords = readFileSync(ledger, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(ledgerRecords.map(({ kind }) => kind)).toEqual([
				"intent",
				"outcome",
			]);
			expect(ledgerRecords[1]?.status).toBe("blocked_unsupported_table");

			const second = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
			});
			expect(second.exitCode).toBe(1);
			expect(second.summary.entries.skipped_by_ledger).toBe(1);
			expect(second.summary.entries.blocked_unsupported_table).toBe(1);
			expect(forwarder.requests).toHaveLength(0);
		} finally {
			await forwarder.close();
		}
	});

	test("archive requires a stopped broker assertion and renames only a clean journal", async () => {
		const { journal, ledger } = testPaths();
		writeJournal(journal, [lossRecord("archive")]);
		const forwarder = await startForwarderServer();
		try {
			await expect(
				runArchiveLossReplay({
					journal,
					ledger,
					forwarderUrl: forwarder.url,
					archive: true,
				}),
			).rejects.toThrow("--archive is refused unless --broker-stopped");
			expect(forwarder.requests).toHaveLength(0);
			expect(existsSync(journal)).toBe(true);

			const result: ArchiveLossReplayResult = await runArchiveLossReplay({
				journal,
				ledger,
				forwarderUrl: forwarder.url,
				archive: true,
				brokerStopped: true,
			});
			expect(result.exitCode).toBe(0);
			expect(existsSync(journal)).toBe(false);
			expect(result.summary.archive.archived_path).toStartWith(
				`${journal}.replayed-`,
			);
			expect(existsSync(result.summary.archive.archived_path as string)).toBe(
				true,
			);
			expect(basename(result.summary.journal)).toBe("archive-loss.jsonl");
		} finally {
			await forwarder.close();
		}
	});
});
