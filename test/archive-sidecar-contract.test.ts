import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseSidecarInvocation,
	removeSidecarEphemeralFiles,
	SidecarUsageError,
	validateMakerSidecarResult,
	validateSidecarManifest,
} from "../scripts/archive-sidecar";

const cexSha = "a".repeat(40);
const makerSha = "b".repeat(40);
const fixture = {
	schemaVersion: "fiet-maker-cex-shared-wire/v2",
	id: "production-compatible-layer12-archive-emitter",
	sha256: "5c9fd679a5a05ebce5f5158f4cc376360f24a34d9a07edeee43e94e564db3ee7",
};
const strategyTables = [
	"strategy_data.policy_evaluation_events",
	"strategy_data.strategy_policy_snapshots",
	"strategy_data.market_identity",
	"strategy_data.symbol_mapping",
	"strategy_data.inventory_settlement_events",
] as const;

function manifest() {
	return {
		schemaVersion: "cex-archive-sidecar/v2",
		runId: "run-a",
		profile: "production_compatible",
		candidateSha: cexSha,
		makerSha,
		artifactsDir: "/tmp/a/run-a",
		manifestPath: "/tmp/a/run-a/manifest.json",
		statePath: "/tmp/a/run-a/state.json",
		logPath: "/tmp/a/run-a/supervisor.log",
		verificationPath: "/tmp/a/run-a/verification.json",
		spoolPath: "/tmp/a/run-a/strategy-spool.sqlite",
		producerAccessPath: "/tmp/a/run-a/producer-access.json",
		makerResultPath: "/tmp/a/run-a/maker-result.json",
		containerName: "cex-sidecar-run-a",
		clickhouseUrl: "http://127.0.0.1:18123",
		forwarderUrl: "http://127.0.0.1:18090/archive",
		forwarderHealthUrl: "http://127.0.0.1:18090/health",
		brokerUrl: "127.0.0.1:18091",
		deploymentId: "sidecar-run-a",
		captureBundleId: "sidecar-bundle-run-a",
		createdAt: "2026-08-04T00:00:00.000Z",
		clickhouseImage: "clickhouse/clickhouse-server:24.8",
		evidenceBounds: {
			readyTimeoutMs: 120_000,
			verificationTimeoutMs: 120_000,
			maxStrategyRows: 1_000,
		},
		sharedWireFixture: fixture,
		strategyExpectation: {
			source: "hb_runtime",
			producerId: "hb_runtime:sidecar-run-a:cex-sidecar-conformance",
			producerRunId: "run-a",
			tableRows: Object.fromEntries(strategyTables.map((table) => [table, 1])),
		},
		supervisorPid: 123,
		commands: {
			up: "bun run archive:sidecar -- up",
			ready: "bun run archive:sidecar -- ready --manifest <path>",
			verify: "bun run archive:sidecar -- verify --manifest <path>",
			down: "bun run archive:sidecar -- down --manifest <path>",
		},
	};
}

function makerResult() {
	return {
		schemaVersion: "fiet-maker-cex-sidecar-conformance/v2",
		status: "passed",
		runId: "run-a",
		profile: "production_compatible",
		makerSha,
		candidateSha: cexSha,
		deploymentId: "sidecar-run-a",
		captureBundleId: "sidecar-bundle-run-a",
		source: "hb_runtime",
		producerId: "hb_runtime:sidecar-run-a:cex-sidecar-conformance",
		producerRunId: "run-a",
		startedAt: "2026-08-04T00:00:00.000Z",
		completedAt: "2026-08-04T00:01:00.000Z",
		delivery: {
			httpStatus: 202,
			batchId: "maker-batch-run-a",
			acceptedRows: 5,
			spoolQueuedBefore: 0,
			spoolQueuedAfter: 0,
		},
		tableRows: Object.fromEntries(
			strategyTables.map((table, index) => [
				table,
				{ count: 1, archiveEventIds: [`run-a-event-${index + 1}`] },
			]),
		),
		profileEvidence: {
			brokerBoundaryObserved: true,
			brokerObservation: {
				schemaVersion: "fiet-hummingbot-external-sidecar-broker/v2",
				status: "passed",
				boundary: "external_sidecar_broker",
				layer12Boundary: "layer12_live_reference_depth",
				currentSnapshotObserved: true,
				liveSubscriptionObserved: true,
			},
			makerCheckout: {
				branch: "develop",
				clean: true,
				sha: makerSha,
				originDevelopSha: makerSha,
				sharedWireFixture: fixture,
				wireContractTests: { exitCode: 0 },
			},
		},
		artifactHashes: {
			sharedWireTest: {
				sha256: fixture.sha256,
			},
		},
	};
}

describe("archive sidecar v2 command contract", () => {
	test("preserves the closed lifecycle and accepts only production_compatible", () => {
		expect(
			parseSidecarInvocation([
				"up",
				"--run-id",
				"run-a",
				"--profile",
				"production_compatible",
				"--candidate-sha",
				cexSha,
				"--maker-sha",
				makerSha,
				"--artifacts-dir",
				"/tmp/archive-sidecar-artifacts",
			]),
		).toMatchObject({
			operation: "up",
			runId: "run-a",
			profile: "production_compatible",
		});
		expect(
			parseSidecarInvocation(["ready", "--manifest", "/tmp/manifest.json"]),
		).toMatchObject({ operation: "ready", timeoutMs: 120_000 });
		for (const operation of ["verify", "down"] as const) {
			expect(
				parseSidecarInvocation([operation, "--manifest", "/tmp/manifest.json"]),
			).toMatchObject({ operation });
		}
	});

	test("rejects native_replay, removed command aliases, and invalid invocations", () => {
		for (const operation of ["prepare", "execute", "cleanup"]) {
			expect(() => parseSidecarInvocation([operation])).toThrow(
				"Operation must be up, ready, verify, or down",
			);
		}
		expect(() =>
			parseSidecarInvocation([
				"up",
				"--run-id",
				"run-a",
				"--profile",
				"native_replay",
				"--candidate-sha",
				cexSha,
				"--maker-sha",
				makerSha,
				"--artifacts-dir",
				"/tmp/a",
			]),
		).toThrow("Unsupported sidecar profile");
		expect(() => parseSidecarInvocation(["up", "--run-id", "run-a"])).toThrow(
			SidecarUsageError,
		);
		expect(() =>
			parseSidecarInvocation([
				"ready",
				"--manifest",
				"/tmp/a",
				"--unknown",
				"x",
			]),
		).toThrow(SidecarUsageError);
	});

	test("accepts only a closed secret-free v2 manifest", () => {
		const value = manifest();
		expect(() => validateSidecarManifest(value)).not.toThrow();
		expect(() =>
			validateSidecarManifest({
				...value,
				schemaVersion: "cex-archive-sidecar/v1",
			}),
		).toThrow("Unsupported manifest schema");
		expect(() =>
			validateSidecarManifest({ ...value, profile: "native_replay" }),
		).toThrow("Unsupported manifest profile");
		expect(() =>
			validateSidecarManifest({ ...value, referenceExportPath: "/tmp/export" }),
		).toThrow("Unknown manifest field referenceExportPath");
		expect(() =>
			validateSidecarManifest({ ...value, apiSecret: "leaked" }),
		).toThrow(SidecarUsageError);
		expect(() =>
			validateSidecarManifest({ ...value, spoolPath: "/tmp/not-run-owned" }),
		).toThrow("not run-owned");
		expect(() =>
			validateSidecarManifest({
				...value,
				strategyExpectation: {
					...value.strategyExpectation,
					tableRows: {
						...value.strategyExpectation.tableRows,
						"strategy_data.symbol_mapping": 2,
					},
				},
			}),
		).toThrow("strategy row counts are invalid");
	});

	test("accepts only bounded v2 hb_runtime results for the exact five tables", async () => {
		const value = makerResult();
		await expect(validateMakerSidecarResult(value)).resolves.toEqual(value);
		await expect(
			validateMakerSidecarResult({
				...value,
				schemaVersion: "fiet-maker-cex-sidecar-conformance/v1",
			}),
		).rejects.toThrow("supported schema");
		await expect(
			validateMakerSidecarResult({ ...value, profile: "native_replay" }),
		).rejects.toThrow("profile is unsupported");
		await expect(
			validateMakerSidecarResult({
				...value,
				source: "maker_replay",
			}),
		).rejects.toThrow("exact external producer");
		await expect(
			validateMakerSidecarResult({
				...value,
				delivery: { ...value.delivery, httpStatus: 200 },
			}),
		).rejects.toThrow("delivery evidence is invalid");

		const incompleteTables = { ...value.tableRows };
		delete incompleteTables["strategy_data.symbol_mapping"];
		await expect(
			validateMakerSidecarResult({ ...value, tableRows: incompleteTables }),
		).rejects.toThrow("unknown or incomplete field set");
	});

	test("requires live Layer12, durable spool, bounded row ids, and hash-bound clean commits", async () => {
		const value = makerResult();
		await expect(
			validateMakerSidecarResult({
				...value,
				artifactHashes: {
					sharedWireTest: { sha256: "d".repeat(64) },
				},
			}),
		).rejects.toThrow("shared-wire test artifact hash is invalid");
		await expect(
			validateMakerSidecarResult({
				...value,
				artifactHashes: {
					...value.artifactHashes,
					policyProof: { sha256: "d".repeat(64) },
				},
			}),
		).rejects.toThrow("unknown or incomplete field set");
		await expect(
			validateMakerSidecarResult({
				...value,
				profileEvidence: {
					...value.profileEvidence,
					brokerObservation: {
						...value.profileEvidence.brokerObservation,
						currentSnapshotObserved: false,
					},
				},
			}),
		).rejects.toThrow("current/live Layer12 broker path");
		await expect(
			validateMakerSidecarResult({
				...value,
				completedAt: "2026-08-04T01:00:00.000Z",
			}),
		).rejects.toThrow("timestamps exceed the bounded run");
		await expect(
			validateMakerSidecarResult({
				...value,
				profileEvidence: {
					...value.profileEvidence,
					makerCheckout: {
						...value.profileEvidence.makerCheckout,
						pr1067Ancestor: true,
					},
				},
			}),
		).rejects.toThrow("unknown or incomplete field set");
		await expect(
			validateMakerSidecarResult({
				...value,
				profileEvidence: {
					...value.profileEvidence,
					immediateHedgeability: { status: "passed" },
				},
			}),
		).rejects.toThrow("unknown or incomplete field set");
	});

	test("supervisor uses controlled production handlers and never fabricates Maker rows", async () => {
		const source = await Bun.file(
			new URL("../scripts/archive-sidecar-supervisor.ts", import.meta.url),
		).text();
		expect(source).toContain("startProductionBrokerCollectorTopology");
		expect(source).toContain("services/archive-forwarder/index.ts");
		expect(source).not.toContain("postStrategy");
		expect(source).not.toContain("strategyRows");
		expect(source).not.toContain("referenceExport");
		expect(source).not.toContain("Parquet");
	});

	test("sidecar source contains no native, Parquet, FIET-907, or Proof A/B aggregation", async () => {
		const source = await Bun.file(
			new URL("../scripts/archive-sidecar.ts", import.meta.url),
		).text();
		for (const removed of [
			"maker_replay",
			"referenceExportPath",
			"parquetOwnership",
			"FIET-907",
			"pr1067Ancestor",
			"proofASha256",
			"proofBSha256",
		]) {
			expect(source).not.toContain(removed);
		}
	});

	test("CLI returns usage code 2 for a missing or unreadable manifest", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"run",
				new URL("../scripts/archive-sidecar.ts", import.meta.url).pathname,
				"verify",
				"--manifest",
				join(tmpdir(), `missing-sidecar-${Date.now()}.json`),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(2);
		expect(stderr).toContain("Invalid sidecar manifest");
	});

	test("failed startup cleanup removes every ephemeral producer and spool file", async () => {
		const artifactsDir = await mkdtemp(join(tmpdir(), "cex-sidecar-cleanup-"));
		const producerAccessPath = join(artifactsDir, "producer-access.json");
		const spoolPath = join(artifactsDir, "strategy-spool.sqlite");
		for (const path of [
			producerAccessPath,
			spoolPath,
			`${spoolPath}-wal`,
			`${spoolPath}-shm`,
		]) {
			await writeFile(path, "sensitive-or-ephemeral\n", { mode: 0o600 });
		}

		await removeSidecarEphemeralFiles({ producerAccessPath, spoolPath });

		for (const path of [
			producerAccessPath,
			spoolPath,
			`${spoolPath}-wal`,
			`${spoolPath}-shm`,
		]) {
			expect(await Bun.file(path).exists()).toBe(false);
		}
		await rm(artifactsDir, { recursive: true, force: true });
	});
});
