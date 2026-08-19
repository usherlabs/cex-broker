#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { createClickHouseInserter } from "../services/archive-forwarder/insert";
import { ensureArchiveSchema } from "../services/archive-forwarder/schema";
import {
	createClickHouseArchiveQueryClient,
	QualifiedOrderBookArchiveReader,
} from "../src/helpers/market-data-vendor-backfill/archive-reader";
import type {
	BackfillResult,
	MarketDataVendorBackfillRequest,
	PromotionReceipt,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import { runMarketDataVendorBackfill } from "../src/helpers/market-data-vendor-backfill/core";
import {
	CRYPTOHFTDATA_BINANCE_SPOT_BTCUSDT_PROFILE,
	CryptoHftDataAdapter,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import { createArchiveForwarderClient } from "../src/helpers/market-data-vendor-backfill/forwarder-client";
import { startArchiveForwarderEndpoint } from "../test/e2e/archive/support/archive-forwarder-endpoint";
import {
	type CanonicalOrderBookParquetExportResult,
	exportCanonicalOrderBookParquet,
} from "./export-canonical-orderbook-parquet";
import { buildCryptoHftDataConformanceRequest } from "./market-data-vendor-backfill-conformance";

export const MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION =
	"market-data-vendor-backfill-local-smoke/v1" as const;

const CLICKHOUSE_IMAGE = "clickhouse/clickhouse-server:24.8";
const CLICKHOUSE_USER = "default";
const SMOKE_MINIMUM_START_MS = Date.UTC(2025, 5, 28);

type Environment = Readonly<Record<string, string | undefined>>;

export type MarketDataVendorBackfillSmokeConfiguration = {
	startTimeMs: number;
	apiKey: string;
	evidencePath?: string;
};

export type MarketDataVendorBackfillSmokeArchiveInspection = {
	candidateLevelRows: number;
	candidateSummaryRows: number;
	qualifiedLevelRows: number;
	qualifiedSummaryRows: number;
	promotionRows: number;
	promotionReceiptIds: string[];
	coverageComplete: boolean;
	coverageDigest: string;
	prefixDigest?: string;
	suffixDigest?: string;
};

export type MarketDataVendorBackfillSmokeExport = {
	levelRows: number;
	summaryRows: number;
	promotionReceiptIds: string[];
	levelsSha256: string;
	summarySha256: string;
};

export type MarketDataVendorBackfillSmokeRuntime = {
	clickhouse: {
		image: string;
		imageId: string;
		version: string;
	};
	run(
		request: MarketDataVendorBackfillRequest,
		apiKey: string,
	): Promise<BackfillResult>;
	inspect(
		request: MarketDataVendorBackfillRequest,
		receipt: PromotionReceipt,
	): Promise<MarketDataVendorBackfillSmokeArchiveInspection>;
	exportQualified(
		request: MarketDataVendorBackfillRequest,
		receipt: PromotionReceipt,
	): Promise<MarketDataVendorBackfillSmokeExport>;
	cleanup(): Promise<void>;
};

type SmokeSourceIdentity = {
	gitCommit: string;
	gitDirty: boolean;
	packageVersion: string;
};

type SmokePhase =
	| "configuration"
	| "source_identity"
	| "runtime_setup"
	| "first_run"
	| "archive_inspection"
	| "qualified_export"
	| "second_run"
	| "idempotency_inspection"
	| "cleanup";

type SmokeResultProjection = Pick<BackfillResult, "status" | "reasonCode">;

type SmokeEvidenceBase = {
	schemaVersion: typeof MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION;
	status: "passed" | "failed";
	startedAtMs: number;
	completedAtMs: number;
	durationMs: number;
};

export type MarketDataVendorBackfillSmokePassedEvidence = SmokeEvidenceBase & {
	status: "passed";
	source: SmokeSourceIdentity;
	clickhouse: MarketDataVendorBackfillSmokeRuntime["clickhouse"];
	request: {
		requestId: string;
		idempotencyKey: string;
		exchange: string;
		tradingPair: string;
		sourceSymbol: string;
		marketType: string;
		feed: string;
		startTimeMs: number;
		endTimeMs: number;
		depth: number;
		constructionMode: string;
	};
	provider: {
		name: "cryptohftdata";
		adapterVersion: string;
		objects: PromotionReceipt["datasetObjects"];
		vendorSemanticDigest: string;
	};
	promotion: {
		captureBundleId: string;
		receiptId: string;
		canonicalSemanticDigest: string;
	};
	firstResult: SmokeResultProjection;
	secondResult: SmokeResultProjection;
	archive: MarketDataVendorBackfillSmokeArchiveInspection;
	export: MarketDataVendorBackfillSmokeExport;
};

export type MarketDataVendorBackfillSmokeFailedEvidence = SmokeEvidenceBase & {
	status: "failed";
	phase: SmokePhase;
	reasonCode: string;
	source?: SmokeSourceIdentity;
	clickhouse?: MarketDataVendorBackfillSmokeRuntime["clickhouse"];
	firstResult?: SmokeResultProjection;
};

export type MarketDataVendorBackfillSmokeEvidence =
	| MarketDataVendorBackfillSmokePassedEvidence
	| MarketDataVendorBackfillSmokeFailedEvidence;

export type MarketDataVendorBackfillSmokeDependencies = {
	createRuntime(): Promise<MarketDataVendorBackfillSmokeRuntime>;
	nowMs(): number;
	sourceIdentity(): Promise<SmokeSourceIdentity>;
};

class SmokeGateError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "SmokeGateError";
	}
}

export function parseMarketDataVendorBackfillSmokeConfiguration(
	environment: Environment,
): MarketDataVendorBackfillSmokeConfiguration {
	if (environment.MARKET_DATA_VENDOR_BACKFILL_SMOKE_ENABLED !== "1") {
		throw new SmokeGateError("market_data_vendor_backfill_smoke_not_enabled");
	}
	const startTimeMs = Number(
		environment.MARKET_DATA_VENDOR_BACKFILL_SMOKE_START_MS ?? "",
	);
	if (
		!Number.isSafeInteger(startTimeMs) ||
		startTimeMs < SMOKE_MINIMUM_START_MS
	) {
		throw new SmokeGateError("market_data_vendor_backfill_smoke_start_invalid");
	}
	const apiKey = environment.CRYPTOHFTDATA_API_KEY?.trim();
	if (!apiKey) throw new SmokeGateError("cryptohftdata_api_key_missing");
	const evidencePath =
		environment.MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_PATH?.trim();
	return {
		startTimeMs,
		apiKey,
		...(evidencePath ? { evidencePath: resolve(evidencePath) } : {}),
	};
}

function projection(result: BackfillResult): SmokeResultProjection {
	return { status: result.status, reasonCode: result.reasonCode };
}

function stableReason(error: unknown): string {
	if (
		error instanceof SmokeGateError &&
		/^[a-z][a-z0-9_]{0,127}$/.test(error.reason)
	) {
		return error.reason;
	}
	return "unexpected_smoke_failure";
}

function sameStrings(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		[...left].sort().every((value, index) => value === [...right].sort()[index])
	);
}

function assertFirstResult(result: BackfillResult): PromotionReceipt {
	if (result.status !== "promoted" || !result.receipt) {
		throw new SmokeGateError("first_run_not_promoted");
	}
	return result.receipt;
}

function assertArchiveInspection(
	inspection: MarketDataVendorBackfillSmokeArchiveInspection,
	receiptId: string,
): void {
	if (
		inspection.candidateLevelRows <= 0 ||
		inspection.candidateSummaryRows <= 0 ||
		inspection.candidateLevelRows !== inspection.qualifiedLevelRows ||
		inspection.candidateSummaryRows !== inspection.qualifiedSummaryRows ||
		inspection.promotionRows !== 1 ||
		!sameStrings(inspection.promotionReceiptIds, [receiptId]) ||
		!inspection.coverageComplete
	) {
		throw new SmokeGateError("archive_qualification_assertion_failed");
	}
}

function assertQualifiedExport(
	exported: MarketDataVendorBackfillSmokeExport,
	inspection: MarketDataVendorBackfillSmokeArchiveInspection,
	receiptId: string,
): void {
	if (
		exported.levelRows !== inspection.qualifiedLevelRows ||
		exported.summaryRows !== inspection.qualifiedSummaryRows ||
		!sameStrings(exported.promotionReceiptIds, [receiptId]) ||
		!/^([a-f0-9]{64})$/.test(exported.levelsSha256) ||
		!/^([a-f0-9]{64})$/.test(exported.summarySha256)
	) {
		throw new SmokeGateError("qualified_export_assertion_failed");
	}
}

function assertIdempotentReplay(
	result: BackfillResult,
	before: MarketDataVendorBackfillSmokeArchiveInspection,
	after: MarketDataVendorBackfillSmokeArchiveInspection,
): void {
	if (
		result.status !== "already_covered" ||
		JSON.stringify(before) !== JSON.stringify(after)
	) {
		throw new SmokeGateError("idempotent_replay_assertion_failed");
	}
}

function passedEvidence(input: {
	startedAtMs: number;
	completedAtMs: number;
	source: SmokeSourceIdentity;
	runtime: MarketDataVendorBackfillSmokeRuntime;
	request: MarketDataVendorBackfillRequest;
	receipt: PromotionReceipt;
	firstResult: BackfillResult;
	secondResult: BackfillResult;
	archive: MarketDataVendorBackfillSmokeArchiveInspection;
	exported: MarketDataVendorBackfillSmokeExport;
}): MarketDataVendorBackfillSmokePassedEvidence {
	return {
		schemaVersion: MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION,
		status: "passed",
		startedAtMs: input.startedAtMs,
		completedAtMs: input.completedAtMs,
		durationMs: Math.max(0, input.completedAtMs - input.startedAtMs),
		source: input.source,
		clickhouse: input.runtime.clickhouse,
		request: {
			requestId: input.request.requestId,
			idempotencyKey: input.request.idempotencyKey,
			exchange: input.request.scope.exchange,
			tradingPair: input.request.scope.tradingPair,
			sourceSymbol: input.request.scope.sourceSymbol,
			marketType: input.request.scope.marketType,
			feed: input.request.scope.feed,
			startTimeMs: input.request.window.startTimeMs,
			endTimeMs: input.request.window.endTimeMs,
			depth: input.request.depth,
			constructionMode: input.request.constructionMode,
		},
		provider: {
			name: "cryptohftdata",
			adapterVersion: input.receipt.adapterVersion,
			objects: input.receipt.datasetObjects,
			vendorSemanticDigest: input.receipt.vendorSemanticDigest,
		},
		promotion: {
			captureBundleId: input.receipt.captureBundleId,
			receiptId: input.receipt.receiptId,
			canonicalSemanticDigest: input.receipt.canonicalSemanticDigest,
		},
		firstResult: projection(input.firstResult),
		secondResult: projection(input.secondResult),
		archive: input.archive,
		export: input.exported,
	};
}

export async function runMarketDataVendorBackfillLocalSmoke(
	configuration: MarketDataVendorBackfillSmokeConfiguration,
	dependencies: MarketDataVendorBackfillSmokeDependencies = {
		createRuntime: createDockerSmokeRuntime,
		nowMs: Date.now,
		sourceIdentity: readSourceIdentity,
	},
): Promise<MarketDataVendorBackfillSmokeEvidence> {
	const startedAtMs = dependencies.nowMs();
	let phase: SmokePhase = "source_identity";
	let source: SmokeSourceIdentity | undefined;
	let runtime: MarketDataVendorBackfillSmokeRuntime | undefined;
	let firstResult: BackfillResult | undefined;
	let evidence: MarketDataVendorBackfillSmokeEvidence;
	try {
		source = await dependencies.sourceIdentity();
		phase = "runtime_setup";
		runtime = await dependencies.createRuntime();
		const request = buildCryptoHftDataConformanceRequest(
			configuration.startTimeMs,
		);

		phase = "first_run";
		firstResult = await runtime.run(request, configuration.apiKey);
		const receipt = assertFirstResult(firstResult);

		phase = "archive_inspection";
		const beforeReplay = await runtime.inspect(request, receipt);
		assertArchiveInspection(beforeReplay, receipt.receiptId);

		phase = "qualified_export";
		const exported = await runtime.exportQualified(request, receipt);
		assertQualifiedExport(exported, beforeReplay, receipt.receiptId);

		phase = "second_run";
		const secondResult = await runtime.run(request, configuration.apiKey);

		phase = "idempotency_inspection";
		const afterReplay = await runtime.inspect(request, receipt);
		assertIdempotentReplay(secondResult, beforeReplay, afterReplay);

		const completedAtMs = dependencies.nowMs();
		evidence = passedEvidence({
			startedAtMs,
			completedAtMs,
			source,
			runtime,
			request,
			receipt,
			firstResult,
			secondResult,
			archive: beforeReplay,
			exported,
		});
	} catch (error) {
		const completedAtMs = dependencies.nowMs();
		evidence = {
			schemaVersion: MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION,
			status: "failed",
			startedAtMs,
			completedAtMs,
			durationMs: Math.max(0, completedAtMs - startedAtMs),
			phase,
			reasonCode: stableReason(error),
			...(source ? { source } : {}),
			...(runtime ? { clickhouse: runtime.clickhouse } : {}),
			...(firstResult ? { firstResult: projection(firstResult) } : {}),
		};
	}

	if (runtime) {
		try {
			await runtime.cleanup();
		} catch {
			const completedAtMs = dependencies.nowMs();
			evidence = {
				schemaVersion:
					MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION,
				status: "failed",
				startedAtMs,
				completedAtMs,
				durationMs: Math.max(0, completedAtMs - startedAtMs),
				phase: "cleanup",
				reasonCode: "runtime_cleanup_failed",
				...(source ? { source } : {}),
				clickhouse: runtime.clickhouse,
				...(firstResult ? { firstResult: projection(firstResult) } : {}),
			};
		}
	}
	return evidence;
}

export async function writeMarketDataVendorBackfillSmokeEvidence(
	evidencePath: string,
	evidence: MarketDataVendorBackfillSmokeEvidence,
): Promise<void> {
	const resolvedPath = resolve(evidencePath);
	await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
	const stagedPath = `${resolvedPath}.${randomUUID()}.tmp`;
	try {
		await writeFile(stagedPath, `${JSON.stringify(evidence, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		await rename(stagedPath, resolvedPath);
	} catch (error) {
		await unlink(stagedPath).catch(() => {});
		throw error;
	}
}

async function command(
	program: string,
	args: readonly string[],
	allowFailure = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const child = Bun.spawn([program, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (stdout.length > 1024 * 1024 || stderr.length > 1024 * 1024) {
		throw new SmokeGateError("subprocess_output_exceeded");
	}
	if (exitCode !== 0 && !allowFailure) {
		throw new SmokeGateError(`${program.replaceAll("-", "_")}_command_failed`);
	}
	return { stdout, stderr, exitCode };
}

async function readSourceIdentity(): Promise<SmokeSourceIdentity> {
	const [commit, status, packageText] = await Promise.all([
		command("git", ["rev-parse", "HEAD"]),
		command("git", ["status", "--porcelain", "--untracked-files=all"]),
		readFile(new URL("../package.json", import.meta.url), "utf8"),
	]);
	const packageJson = JSON.parse(packageText) as { version?: unknown };
	if (typeof packageJson.version !== "string" || !packageJson.version) {
		throw new SmokeGateError("package_version_invalid");
	}
	return {
		gitCommit: commit.stdout.trim(),
		gitDirty: status.stdout.trim().length > 0,
		packageVersion: packageJson.version,
	};
}

function sha256File(path: string): Promise<string> {
	return readFile(path).then((bytes) =>
		createHash("sha256").update(bytes).digest("hex"),
	);
}

function numericField(row: Record<string, unknown>, field: string): number {
	const value = Number(row[field]);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new SmokeGateError("archive_inspection_invalid");
	}
	return value;
}

async function inspectArchive(
	client: ClickHouseClient,
	reader: QualifiedOrderBookArchiveReader,
	request: MarketDataVendorBackfillRequest,
	receipt: PromotionReceipt,
): Promise<MarketDataVendorBackfillSmokeArchiveInspection> {
	const scope = `
		capture_bundle_id = {capture_bundle_id:String}
		AND source = 'external_backfill'
		AND exchange = {exchange:String}
		AND trading_pair = {trading_pair:String}
		AND asset_type = {asset_type:String}
		AND feed = {feed:String}
		AND provider = {provider:String}
		AND source_time_ms >= {start_time_ms:UInt64}
		AND source_time_ms < {end_time_ms:UInt64}
		AND depth_limit = {depth_limit:UInt16}
		AND construction_mode = {construction_mode:String}
		AND schema_version = {schema_version:String}
		AND checksum_algorithm = {checksum_algorithm:String}`;
	const result = await client.query({
		query: `
			SELECT
			  (SELECT count() FROM market_data.cex_order_book_levels_canonical WHERE ${scope}) AS candidate_levels,
			  (SELECT count() FROM market_data.cex_order_book_depth_summary_canonical WHERE ${scope}) AS candidate_summaries,
			  (SELECT count() FROM market_data.cex_order_book_levels_replay_qualified WHERE ${scope}) AS qualified_levels,
			  (SELECT count() FROM market_data.cex_order_book_depth_summary_replay_qualified WHERE ${scope}) AS qualified_summaries,
			  (SELECT count() FROM market_data.cex_order_book_capture_promotions
			   WHERE capture_bundle_id = {capture_bundle_id:String}
			     AND receipt_id = {receipt_id:String}
			     AND source = 'external_backfill'
			     AND exchange = {exchange:String}
			     AND trading_pair = {trading_pair:String}
			     AND asset_type = {asset_type:String}
			     AND feed = {feed:String}
			     AND provider = {provider:String}
			     AND window_start_ms = {start_time_ms:UInt64}
			     AND window_end_ms = {end_time_ms:UInt64}
			     AND depth_limit = {depth_limit:UInt16}
			     AND construction_mode = {construction_mode:String}
			     AND schema_version = {schema_version:String}
			     AND checksum_algorithm = {checksum_algorithm:String}) AS promotions,
			  (SELECT groupUniqArray(receipt_id)
			   FROM market_data.cex_order_book_capture_promotions
			   WHERE capture_bundle_id = {capture_bundle_id:String}) AS receipt_ids`,
		query_params: {
			capture_bundle_id: receipt.captureBundleId,
			receipt_id: receipt.receiptId,
			exchange: receipt.exchange,
			trading_pair: receipt.tradingPair,
			asset_type: receipt.marketType,
			feed: receipt.feed,
			provider: receipt.provider,
			start_time_ms: receipt.startTimeMs,
			end_time_ms: receipt.endTimeMs,
			depth_limit: receipt.depth,
			construction_mode: receipt.constructionMode,
			schema_version: receipt.canonicalSchemaVersion,
			checksum_algorithm: receipt.checksumAlgorithm,
		},
		format: "JSONEachRow",
	});
	const rows = (await result.json()) as Record<string, unknown>[];
	const row = rows[0];
	if (!row || !Array.isArray(row.receipt_ids)) {
		throw new SmokeGateError("archive_inspection_invalid");
	}
	const coverage = await reader.coverage(request);
	return {
		candidateLevelRows: numericField(row, "candidate_levels"),
		candidateSummaryRows: numericField(row, "candidate_summaries"),
		qualifiedLevelRows: numericField(row, "qualified_levels"),
		qualifiedSummaryRows: numericField(row, "qualified_summaries"),
		promotionRows: numericField(row, "promotions"),
		promotionReceiptIds: row.receipt_ids.map(String).sort(),
		coverageComplete: coverage.complete,
		coverageDigest: coverage.coverageDigest,
		...(coverage.prefixDigest ? { prefixDigest: coverage.prefixDigest } : {}),
		...(coverage.suffixDigest ? { suffixDigest: coverage.suffixDigest } : {}),
	};
}

async function projectExport(
	exported: CanonicalOrderBookParquetExportResult,
): Promise<MarketDataVendorBackfillSmokeExport> {
	const [levelsSha256, summarySha256] = await Promise.all([
		sha256File(exported.levelsPath),
		sha256File(exported.summaryPath),
	]);
	return {
		levelRows: exported.levelRows,
		summaryRows: exported.summaryRows,
		promotionReceiptIds: exported.promotionReceiptIds,
		levelsSha256,
		summarySha256,
	};
}

async function createDockerSmokeRuntime(): Promise<MarketDataVendorBackfillSmokeRuntime> {
	const containerName = `cex-broker-vendor-smoke-${randomUUID()}`;
	const clickhousePassword = randomUUID();
	const forwarderToken = randomUUID();
	const exportDirectory = await mkdtemp(
		join(tmpdir(), "market-data-vendor-backfill-export-"),
	);
	let containerStarted = false;
	let client: ClickHouseClient | undefined;
	let endpoint:
		| Awaited<ReturnType<typeof startArchiveForwarderEndpoint>>
		| undefined;
	try {
		await command("docker", [
			"run",
			"-d",
			"--name",
			containerName,
			"--label",
			"cex-broker.market-data-vendor-backfill-smoke=true",
			"-e",
			`CLICKHOUSE_USER=${CLICKHOUSE_USER}`,
			"-e",
			`CLICKHOUSE_PASSWORD=${clickhousePassword}`,
			"-p",
			"127.0.0.1::8123",
			CLICKHOUSE_IMAGE,
		]);
		containerStarted = true;
		const [port, image] = await Promise.all([
			command("docker", ["port", containerName, "8123/tcp"]),
			command("docker", [
				"image",
				"inspect",
				"--format",
				"{{.Id}}",
				CLICKHOUSE_IMAGE,
			]),
		]);
		const portMatch = port.stdout.match(/:(\d+)\s*$/m);
		if (!portMatch) throw new SmokeGateError("clickhouse_port_unavailable");
		const clickhouseUrl = `http://127.0.0.1:${portMatch[1]}`;
		client = createClient({
			url: clickhouseUrl,
			username: CLICKHOUSE_USER,
			password: clickhousePassword,
			request_timeout: 30_000,
		});
		const deadline = Date.now() + 60_000;
		let version: string | undefined;
		while (Date.now() < deadline) {
			try {
				const response = await client.query({
					query: "SELECT version() AS version",
					format: "JSONEachRow",
				});
				const rows = (await response.json()) as Array<{ version?: string }>;
				version = rows[0]?.version;
				if (version) break;
			} catch {
				await Bun.sleep(250);
			}
		}
		if (!version?.startsWith("24.8.")) {
			throw new SmokeGateError("clickhouse_version_mismatch");
		}
		await ensureArchiveSchema(client);
		endpoint = await startArchiveForwarderEndpoint({
			inserter: createClickHouseInserter(client),
			authToken: forwarderToken,
		});

		const reader = new QualifiedOrderBookArchiveReader(
			createClickHouseArchiveQueryClient({
				url: clickhouseUrl,
				username: CLICKHOUSE_USER,
				password: clickhousePassword,
			}),
		);
		const adapter = new CryptoHftDataAdapter({
			profiles: [CRYPTOHFTDATA_BINANCE_SPOT_BTCUSDT_PROFILE],
		});
		const forwarder = createArchiveForwarderClient({
			url: endpoint.url,
			authToken: forwarderToken,
		});
		let cleaned = false;
		const runtime: MarketDataVendorBackfillSmokeRuntime = {
			clickhouse: {
				image: CLICKHOUSE_IMAGE,
				imageId: image.stdout.trim(),
				version,
			},
			run: (request, apiKey) =>
				runMarketDataVendorBackfill(request, {
					archive: reader,
					providers: adapter,
					credentials: {
						resolve: async () => ({ apiKey }),
					},
					forwarder,
					clock: { nowMs: Date.now },
					retry: { maxAttempts: 3, wait: () => Bun.sleep(250) },
				}),
			inspect: (request, receipt) =>
				inspectArchive(client as ClickHouseClient, reader, request, receipt),
			async exportQualified(request, receipt) {
				const exported = await exportCanonicalOrderBookParquet({
					clickhouseUrl,
					username: CLICKHOUSE_USER,
					password: clickhousePassword,
					outputDirectory: exportDirectory,
					captureBundleIds: [receipt.captureBundleId],
					exchange: request.scope.exchange,
					tradingPair: request.scope.tradingPair,
					startTimeMs: request.window.startTimeMs,
					endTimeMs: request.window.endTimeMs,
				});
				return projectExport(exported);
			},
			async cleanup() {
				if (cleaned) return;
				cleaned = true;
				process.off("SIGINT", handleSigint);
				process.off("SIGTERM", handleSigterm);
				const failures: unknown[] = [];
				await endpoint?.close().catch((error) => failures.push(error));
				await client?.close().catch((error) => failures.push(error));
				await command("docker", ["rm", "-f", containerName], true).catch(
					(error) => failures.push(error),
				);
				await rm(exportDirectory, { recursive: true, force: true }).catch(
					(error) => failures.push(error),
				);
				if (failures.length > 0) {
					throw new SmokeGateError("runtime_cleanup_failed");
				}
			},
		};
		const handleSigint = () => {
			void runtime.cleanup().finally(() => process.exit(130));
		};
		const handleSigterm = () => {
			void runtime.cleanup().finally(() => process.exit(143));
		};
		process.once("SIGINT", handleSigint);
		process.once("SIGTERM", handleSigterm);
		return runtime;
	} catch (error) {
		await endpoint?.close().catch(() => {});
		await client?.close().catch(() => {});
		if (containerStarted) {
			await command("docker", ["rm", "-f", containerName], true).catch(
				() => {},
			);
		}
		await rm(exportDirectory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

function configurationFailureEvidence(
	startedAtMs: number,
	error: unknown,
): MarketDataVendorBackfillSmokeFailedEvidence {
	const completedAtMs = Date.now();
	return {
		schemaVersion: MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_SCHEMA_VERSION,
		status: "failed",
		startedAtMs,
		completedAtMs,
		durationMs: Math.max(0, completedAtMs - startedAtMs),
		phase: "configuration",
		reasonCode: stableReason(error),
	};
}

async function main(): Promise<void> {
	const startedAtMs = Date.now();
	let evidence: MarketDataVendorBackfillSmokeEvidence;
	let evidencePath =
		process.env.MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_PATH?.trim();
	try {
		const configuration = parseMarketDataVendorBackfillSmokeConfiguration(
			process.env,
		);
		evidencePath = configuration.evidencePath;
		evidence = await runMarketDataVendorBackfillLocalSmoke(configuration);
	} catch (error) {
		evidence = configurationFailureEvidence(startedAtMs, error);
	}
	if (evidencePath) {
		await writeMarketDataVendorBackfillSmokeEvidence(evidencePath, evidence);
	}
	console.info(JSON.stringify(evidence));
	if (evidence.status !== "passed") process.exitCode = 1;
}

if (import.meta.main) {
	void main().catch(() => {
		process.exitCode = 1;
	});
}
