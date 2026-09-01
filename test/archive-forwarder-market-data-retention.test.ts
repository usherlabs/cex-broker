import { describe, expect, test } from "bun:test";
import { handleArchiveRequest } from "../services/archive-forwarder/request";
import { StrategyArchiveSpool } from "../services/archive-forwarder/strategy-spool";
import { StrategySpoolWorker } from "../services/archive-forwarder/strategy-worker";
import {
	ArchiveForwarderTelemetry,
	type ArchiveMetricsRecorder,
} from "../services/archive-forwarder/telemetry";
import strategyFixture from "./fixtures/archive_forwarder_envelope.json";

const noopRecorder: ArchiveMetricsRecorder = {
	recordCounter: () => {},
	setObservableGauge: () => {},
};

/**
 * The verbatim shape ClickHouse Cloud returns once the service is at its total
 * memory ceiling. The zero-byte allocation is the load-bearing detail: the
 * insert is refused before it allocates anything, so it is the server that is
 * saturated rather than the batch that is too large.
 */
const MEMORY_LIMIT_ERROR = new Error(
	"(total) memory limit exceeded: would use 11.08 GiB (attempt to allocate chunk of 0.00 B), current RSS: 11.08 GiB, maximum: 10.80 GiB",
);
const SCHEMA_ERROR = new Error("Unknown table market_data.cex_ohlcv");

function marketDataBatch(tables: string[] = ["market_data.cex_ohlcv"]) {
	return {
		source: "prod-eu-1-read",
		deployment_id: "deployment-1",
		rows: tables.map((table, index) => ({
			table,
			row: {
				exchange: "binance",
				trading_pair: "BTC/USDT",
				sequence: index + 1,
			},
		})),
	};
}

function post(body: unknown): Request {
	return new Request("http://localhost/archive", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function telemetry(): ArchiveForwarderTelemetry {
	return new ArchiveForwarderTelemetry(noopRecorder);
}

describe("market_data durable retention", () => {
	test("retains rows and returns 202 when ClickHouse is over its memory limit", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		const response = await handleArchiveRequest(post(marketDataBatch()), {
			inserter: async () => {
				throw MEMORY_LIMIT_ERROR;
			},
			spool,
			telemetry: telemetry(),
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ok: true, retained: 1 });
		expect(spool.stats("market_data")).toMatchObject({
			queuedBatches: 1,
			queuedWork: 1,
		});
		// The strategy lane must be untouched by a market_data outage.
		expect(spool.stats()).toMatchObject({ queuedBatches: 0, queuedWork: 0 });
		spool.close();
	});

	test("keeps failing with 500 when the error is not retryable", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		const response = await handleArchiveRequest(post(marketDataBatch()), {
			inserter: async () => {
				throw SCHEMA_ERROR;
			},
			spool,
			telemetry: telemetry(),
		});

		// Invariant guard: this asserts behaviour that must hold both before and
		// after retention existed, so it passes on either side by design — do not
		// "fix" it by making a schema fault retainable. A schema fault never
		// drains, so retaining it would fill the spool while hiding the fault
		// behind a success code.
		expect(response.status).toBe(500);
		expect(spool.stats("market_data")).toMatchObject({
			queuedBatches: 0,
			queuedWork: 0,
		});
		spool.close();
	});

	test("retains only the table that failed, never one that already landed", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		const landed: string[] = [];
		const response = await handleArchiveRequest(
			post(
				marketDataBatch(["market_data.cex_ohlcv", "market_data.cex_trades"]),
			),
			{
				inserter: async (table) => {
					if (table === "market_data.cex_trades") {
						throw MEMORY_LIMIT_ERROR;
					}
					landed.push(table);
				},
				spool,
				telemetry: telemetry(),
			},
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ inserted: 1, retained: 1 });
		expect(landed).toEqual(["market_data.cex_ohlcv"]);
		expect(spool.dueWork().map((work) => work.table)).toEqual([
			"market_data.cex_trades",
		]);
		spool.close();
	});

	test("a full market_data budget stops retaining without touching the strategy lane", async () => {
		// Size the market_data budget to exactly one batch so the second retention
		// is the one that overflows, rather than relying on a guessed byte count.
		const probe = new StrategyArchiveSpool({ path: ":memory:" });
		const batchBytes = probe.accountedBytes(marketDataBatch());
		probe.close();

		const spool = new StrategyArchiveSpool({
			path: ":memory:",
			limits: { marketDataMaxBytes: batchBytes },
		});
		const saturatedInserter = async () => {
			throw MEMORY_LIMIT_ERROR;
		};

		const firstRetained = await handleArchiveRequest(post(marketDataBatch()), {
			inserter: saturatedInserter,
			spool,
			telemetry: telemetry(),
		});
		expect(firstRetained.status).toBe(202);

		// Budget is now full: the caller must get its failure back rather than a
		// success code, so its own dead-letter path stays the last resort.
		const overflowed = await handleArchiveRequest(post(marketDataBatch()), {
			inserter: saturatedInserter,
			spool,
			telemetry: telemetry(),
		});
		expect(overflowed.status).toBe(500);
		expect(spool.stats("market_data")).toMatchObject({ queuedBatches: 1 });

		// The strategy lane keeps its own budget and admits regardless.
		const admitted = await handleArchiveRequest(post(strategyFixture), {
			inserter: saturatedInserter,
			spool,
			telemetry: telemetry(),
		});
		expect(admitted.status).toBe(202);
		expect(spool.stats()).toMatchObject({ queuedBatches: 1 });
		spool.close();
	});

	test("the drain worker lands retained rows once ClickHouse recovers", async () => {
		const spool = new StrategyArchiveSpool({ path: ":memory:" });
		const landed: string[] = [];
		let saturated = true;
		const inserter = async (table: string) => {
			if (saturated) {
				throw MEMORY_LIMIT_ERROR;
			}
			landed.push(table);
		};

		const response = await handleArchiveRequest(post(marketDataBatch()), {
			inserter,
			spool,
			telemetry: telemetry(),
		});
		expect(response.status).toBe(202);

		saturated = false;
		const worker = new StrategySpoolWorker({
			spool,
			inserter,
			telemetry: telemetry(),
		});
		expect(await worker.drainOnce()).toMatchObject({ completed: 1 });
		expect(landed).toEqual(["market_data.cex_ohlcv"]);
		expect(spool.stats("market_data")).toMatchObject({ queuedWork: 0 });
		spool.close();
	});

	test("an existing spool file created before retention still opens", async () => {
		const path = `/tmp/archive-spool-migration-${Date.now()}.sqlite`;
		const before = new StrategyArchiveSpool({ path });
		before.admit(strategyFixture);
		before.close();

		// Reopening runs the spool_class migration against a populated file; the
		// pre-existing batch must remain visible in the strategy lane.
		const after = new StrategyArchiveSpool({ path });
		expect(after.stats()).toMatchObject({ queuedBatches: 1 });
		expect(after.stats("market_data")).toMatchObject({ queuedBatches: 0 });
		after.close();
	});
});
