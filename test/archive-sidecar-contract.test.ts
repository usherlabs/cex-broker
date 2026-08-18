import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseSidecarInvocation,
	removeSidecarEphemeralFiles,
	SidecarUsageError,
	validateMakerSidecarResult,
	validateSidecarManifest,
} from "../scripts/archive-sidecar";

const sha = "a".repeat(40);
const makerCheckout = {
	branch: "develop",
	clean: true,
	sha: "b".repeat(40),
	originDevelopSha: "b".repeat(40),
	pr1067Ancestor: true,
	fixtureSha256:
		"784f647e048052a6c3382309b1a86abfbe08bc162363ead9fc88eaa1ba3d50c9",
	wireContractTests: { exitCode: 0 },
};
const proofASamplePath = new URL(
	"../openspec/changes/archive-market-data-once-per-feed/evidence/cex-orderbook-coalescing-evidence.sample.json",
	import.meta.url,
);

function proofBCase(venue: "binance" | "mexc") {
	const output = {
		bidDepth: 10,
		askDepth: 12,
		limitingSide: "bid",
		envelopeLiquidityCap: 9.75,
		selectedWidthTicks: 120,
		authoredPosition: { lowerOffset: -60, upperOffset: 60 },
		positionRebalanceReason: "fresh_start",
	};
	return {
		venue,
		profileId: `${venue}:l2-diff:500`,
		evaluations: [
			{
				index: 0,
				streams: {
					conservativeLive: output,
					conservativeRehydrated: output,
					coalescedLive: output,
					coalescedRehydrated: output,
				},
				equivalenceVerdicts: {
					liveVsRehydrated: true,
					conservativeVsCoalesced: true,
				},
				diagnosticHashes: { input: "c".repeat(64) },
			},
		],
		equivalenceVerdicts: {
			liveVsRehydrated: true,
			conservativeVsCoalesced: true,
		},
		diagnosticHashes: { evaluations: "d".repeat(64) },
	};
}

async function writeProofBundle() {
	const artifactsDir = await mkdtemp(join(tmpdir(), "cex-sidecar-proof-"));
	const cexEvidencePath = join(
		artifactsDir,
		"cex-orderbook-coalescing-evidence.json",
	);
	await copyFile(proofASamplePath, cexEvidencePath);
	const cexBytes = await readFile(cexEvidencePath);
	const cexSha256 = createHash("sha256").update(cexBytes).digest("hex");
	const proofBPath = join(artifactsDir, "maker-proof-b.json");
	const proofB = {
		schemaVersion: "fiet-maker-immediate-hedgeability/v2",
		status: "passed",
		sourceCexEvidence: {
			schemaVersion: "cex-orderbook-coalescing-evidence/v1",
			sha256: cexSha256,
		},
		policyConfigSha256: "e".repeat(64),
		cases: [proofBCase("binance"), proofBCase("mexc")],
		artifactHashes: { diagnostics: "f".repeat(64) },
	};
	await writeFile(proofBPath, `${JSON.stringify(proofB)}\n`);
	const proofBSha256 = createHash("sha256")
		.update(await readFile(proofBPath))
		.digest("hex");
	return {
		artifactsDir,
		cexEvidencePath,
		proofBPath,
		proofB,
		descriptor: {
			schemaVersion: "fiet-maker-immediate-hedgeability-attachment/v1",
			path: proofBPath,
			sha256: proofBSha256,
		},
	};
}

describe("archive sidecar command contract", () => {
	test("parses the closed non-interactive operation and flag surface", () => {
		expect(
			parseSidecarInvocation([
				"up",
				"--run-id",
				"run-a",
				"--profile",
				"native_replay",
				"--candidate-sha",
				sha,
				"--maker-sha",
				"b".repeat(40),
				"--artifacts-dir",
				"/tmp/archive-sidecar-artifacts",
			]),
		).toMatchObject({
			operation: "up",
			runId: "run-a",
			profile: "native_replay",
		});
		expect(
			parseSidecarInvocation(["ready", "--manifest", "/tmp/manifest.json"]),
		).toMatchObject({ operation: "ready", timeoutMs: 120_000 });
	});

	test("treats missing identity, unsupported profiles, and flags as usage errors", () => {
		for (const args of [
			["up", "--run-id", "run-a"],
			[
				"up",
				"--run-id",
				"run-a",
				"--profile",
				"unknown",
				"--candidate-sha",
				sha,
				"--maker-sha",
				sha,
				"--artifacts-dir",
				"/tmp/a",
			],
			["ready", "--manifest", "/tmp/a", "--unknown", "x"],
		]) {
			expect(() => parseSidecarInvocation(args)).toThrow(SidecarUsageError);
		}
	});

	test("accepts only whitelisted secret-free manifest fields", () => {
		const manifest = {
			schemaVersion: "cex-archive-sidecar/v1",
			runId: "run-a",
			profile: "production_compatible",
			candidateSha: sha,
			archiveImplementationSha: "3398066ae2c396a9a9e0220f88715ac22b6d8694",
			makerSha: "b".repeat(40),
			baselineSha: "7a83de5f29a08f42d81f64a75a83bc9318dce94a",
			artifactsDir: "/tmp/a/run-a",
			manifestPath: "/tmp/a/run-a/manifest.json",
			statePath: "/tmp/a/run-a/state.json",
			logPath: "/tmp/a/run-a/supervisor.log",
			verificationPath: "/tmp/a/run-a/verification.json",
			spoolPath: "/tmp/a/run-a/strategy-spool.sqlite",
			producerAccessPath: "/tmp/a/run-a/producer-access.json",
			makerResultPath: "/tmp/a/run-a/maker-result.json",
			referenceExportPath: "/tmp/a/run-a/reference-export.json",
			cexEvidencePath: "/tmp/a/run-a/cex-orderbook-coalescing-evidence.json",
			containerName: "cex-sidecar-run-a",
			clickhouseUrl: "http://127.0.0.1:18123",
			forwarderUrl: "http://127.0.0.1:18090/archive",
			forwarderHealthUrl: "http://127.0.0.1:18090/health",
			brokerUrl: "127.0.0.1:18091",
			deploymentId: "sidecar-run-a",
			captureBundleId: "sidecar-bundle-run-a",
			createdAt: "2026-08-04T00:00:00.000Z",
			clickhouseImage: "clickhouse/clickhouse-server:24.8",
			supervisorPid: 123,
			commands: {
				up: "bun run archive:sidecar -- up",
				ready: "bun run archive:sidecar -- ready --manifest <path>",
				verify: "bun run archive:sidecar -- verify --manifest <path>",
				down: "bun run archive:sidecar -- down --manifest <path>",
			},
		};
		expect(() => validateSidecarManifest(manifest)).not.toThrow();
		expect(() =>
			validateSidecarManifest({ ...manifest, apiSecret: "leaked" }),
		).toThrow(SidecarUsageError);
		expect(() =>
			validateSidecarManifest({ ...manifest, spoolPath: "/tmp/not-run-owned" }),
		).toThrow(SidecarUsageError);
	});

	test("accepts only Maker-authored results bound to the run and exact producer", async () => {
		const result = {
			schemaVersion: "fiet-maker-cex-sidecar-conformance/v1",
			status: "passed",
			runId: "run-a",
			profile: "native_replay",
			makerSha: "b".repeat(40),
			candidateSha: sha,
			deploymentId: "sidecar-run-a",
			source: "maker_replay",
			producerId: "maker_replay:sidecar-run-a:cex-sidecar-conformance",
			producerRunId: "run-a",
			delivery: {
				httpStatus: 200,
				acceptedRows: 5,
				spoolQueuedBefore: 0,
				spoolQueuedAfter: 0,
			},
			tableRows: {
				"strategy_data.policy_evaluation_events": 1,
				"strategy_data.strategy_policy_snapshots": 1,
				"strategy_data.market_identity": 1,
				"strategy_data.symbol_mapping": 1,
				"strategy_data.inventory_settlement_events": 1,
			},
			profileEvidence: {
				brokerBoundaryObserved: false,
				makerCheckout,
				consumer: {
					path: "hb_maker_emulation.order_book_depth_sourcing.load_precomputed_order_book",
					sourceMode: "vendor_archive_normalized",
					levelRows: 2,
					summaryRows: 1,
				},
			},
			artifactHashes: {},
		};
		await expect(validateMakerSidecarResult(result)).resolves.toEqual(result);
		await expect(
			validateMakerSidecarResult({
				...result,
				producerId: "fiet-maker-sidecar",
			}),
		).rejects.toBeInstanceOf(SidecarUsageError);
		await expect(
			validateMakerSidecarResult({
				...result,
				profileEvidence: {
					brokerBoundaryObserved: true,
					makerCheckout,
					consumer: {
						path: "hb_maker_emulation.order_book_depth_sourcing.load_precomputed_order_book",
						sourceMode: "vendor_archive_normalized",
						levelRows: 2,
						summaryRows: 1,
					},
				},
			}),
		).rejects.toBeInstanceOf(SidecarUsageError);
	});

	test("requires production results to bind a run-owned Maker Proof B v2 to real Proof A", async () => {
		const bundle = await writeProofBundle();
		const result = {
			schemaVersion: "fiet-maker-cex-sidecar-conformance/v1",
			status: "passed",
			runId: "run-production",
			profile: "production_compatible",
			makerSha: "b".repeat(40),
			candidateSha: sha,
			deploymentId: "sidecar-run-production",
			source: "hb_runtime",
			producerId: "hb_runtime:sidecar-run-production:cex-sidecar-conformance",
			producerRunId: "run-production",
			delivery: {
				httpStatus: 202,
				acceptedRows: 5,
				spoolQueuedBefore: 0,
				spoolQueuedAfter: 0,
			},
			tableRows: {
				"strategy_data.policy_evaluation_events": 1,
				"strategy_data.strategy_policy_snapshots": 1,
				"strategy_data.market_identity": 1,
				"strategy_data.symbol_mapping": 1,
				"strategy_data.inventory_settlement_events": 1,
			},
			profileEvidence: {
				brokerBoundaryObserved: true,
				makerCheckout,
				immediateHedgeability: bundle.descriptor,
				brokerObservation: {
					schemaVersion: "fiet-hummingbot-external-sidecar-broker/v1",
					status: "passed",
					boundary: "external_sidecar_broker",
					layer12Boundary: "layer12_live_reference_depth",
				},
			},
			artifactHashes: {},
		};
		try {
			await expect(
				validateMakerSidecarResult(result, {
					artifactsDir: bundle.artifactsDir,
					cexEvidencePath: bundle.cexEvidencePath,
				}),
			).resolves.toEqual(result);
			await expect(
				validateMakerSidecarResult(
					{
						...result,
						profileEvidence: {
							...result.profileEvidence,
							immediateHedgeability: {
								...bundle.descriptor,
								path: join(bundle.artifactsDir, "..", "escaped.json"),
							},
						},
					},
					{
						artifactsDir: bundle.artifactsDir,
						cexEvidencePath: bundle.cexEvidencePath,
					},
				),
			).rejects.toThrow("run-owned");

			const oneVenueProofB = {
				...bundle.proofB,
				cases: [proofBCase("binance")],
			};
			await writeFile(bundle.proofBPath, `${JSON.stringify(oneVenueProofB)}\n`);
			const oneVenueDescriptor = {
				...bundle.descriptor,
				sha256: createHash("sha256")
					.update(await readFile(bundle.proofBPath))
					.digest("hex"),
			};
			await expect(
				validateMakerSidecarResult(
					{
						...result,
						profileEvidence: {
							...result.profileEvidence,
							immediateHedgeability: oneVenueDescriptor,
						},
					},
					{
						artifactsDir: bundle.artifactsDir,
						cexEvidencePath: bundle.cexEvidencePath,
					},
				),
			).rejects.toThrow("exactly one Binance and MEXC case");

			const staleProofB = {
				...bundle.proofB,
				sourceCexEvidence: {
					schemaVersion: "cex-orderbook-coalescing-evidence/v1",
					sha256: "0".repeat(64),
				},
			};
			await writeFile(bundle.proofBPath, `${JSON.stringify(staleProofB)}\n`);
			const staleDescriptor = {
				...bundle.descriptor,
				sha256: createHash("sha256")
					.update(await readFile(bundle.proofBPath))
					.digest("hex"),
			};
			await expect(
				validateMakerSidecarResult(
					{
						...result,
						profileEvidence: {
							...result.profileEvidence,
							immediateHedgeability: staleDescriptor,
						},
					},
					{
						artifactsDir: bundle.artifactsDir,
						cexEvidencePath: bundle.cexEvidencePath,
					},
				),
			).rejects.toThrow("current CEX Proof A");

			const forbiddenProofB = {
				...bundle.proofB,
				sharedObservation: { physicalWatches: 1 },
			};
			await writeFile(
				bundle.proofBPath,
				`${JSON.stringify(forbiddenProofB)}\n`,
			);
			const forbiddenDescriptor = {
				...bundle.descriptor,
				sha256: createHash("sha256")
					.update(await readFile(bundle.proofBPath))
					.digest("hex"),
			};
			await expect(
				validateMakerSidecarResult(
					{
						...result,
						profileEvidence: {
							...result.profileEvidence,
							immediateHedgeability: forbiddenDescriptor,
						},
					},
					{
						artifactsDir: bundle.artifactsDir,
						cexEvidencePath: bundle.cexEvidencePath,
					},
				),
			).rejects.toThrow("forbidden CEX-owned field");
		} finally {
			await rm(bundle.artifactsDir, { recursive: true, force: true });
		}
	});

	test("supervisor never fabricates Maker strategy rows", async () => {
		const source = await Bun.file(
			new URL("../scripts/archive-sidecar-supervisor.ts", import.meta.url),
		).text();
		expect(source).not.toContain("postStrategy");
		expect(source).not.toContain("strategyRows");
		expect(source).not.toContain("archive-baseline-v1.json");
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
	});
});
