import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { readArchiveClusterIdentity } from "../services/archive-forwarder/health";
import { createClickHouseInserter } from "../services/archive-forwarder/insert";
import { ensureArchiveSchema } from "../services/archive-forwarder/schema";
import {
	createClickHouseExactOrderBookExportClient,
	exportExactCanonicalOrderBook,
} from "../src/helpers/canonical-orderbook-export/exporter";
import {
	createClickHouseArchiveQueryClient,
	QualifiedOrderBookArchiveReader,
} from "../src/helpers/market-data-vendor-backfill/archive-reader";
import type {
	ForwarderBatch,
	MarketDataVendorBackfillRequest,
} from "../src/helpers/market-data-vendor-backfill/contracts";
import { createArchiveForwarderClient } from "../src/helpers/market-data-vendor-backfill/forwarder-client";
import { jcsSha256 } from "../src/helpers/market-data-vendor-backfill/identity";
import {
	assertSourceTapeSandboxAuthorization,
	SOURCE_TAPE_SANDBOX_TARGET,
} from "../src/helpers/source-tape";
import { startArchiveForwarderEndpoint } from "../test/e2e/archive/support/archive-forwarder-endpoint";
import {
	MARKET_DATA_QUALIFICATION_CLICKHOUSE_IMAGE,
	MARKET_DATA_QUALIFICATION_CLICKHOUSE_VERSION,
} from "./market-data-vendor-backfill-local-smoke";

const CLICKHOUSE_USER = "default";

async function boundedCommand(
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
		throw new Error("qualification_sandbox_subprocess_output_exceeded");
	}
	if (exitCode !== 0 && !allowFailure) {
		throw new Error("qualification_sandbox_command_failed");
	}
	return { stdout, stderr, exitCode };
}

export type MarketDataQualificationSandboxRuntime = {
	clickhouse: {
		image: typeof MARKET_DATA_QUALIFICATION_CLICKHOUSE_IMAGE;
		imageId: string;
		version: typeof MARKET_DATA_QUALIFICATION_CLICKHOUSE_VERSION;
	};
	outputDirectory: string;
	queryClient: ReturnType<typeof createClickHouseArchiveQueryClient>;
	forwarder: {
		submit(batch: ForwarderBatch): Promise<{ ok: boolean; inserted: number }>;
	};
	archive: {
		resolveSelection(
			request: MarketDataVendorBackfillRequest,
		): Promise<
			Awaited<
				ReturnType<QualifiedOrderBookArchiveReader["resolveSelection"]>
			>["selection"]
		>;
	};
	exporter: {
		export(
			request: Parameters<typeof exportExactCanonicalOrderBook>[0]["request"],
		): Promise<{
			promotionReceiptIds: string[];
			levels: Awaited<
				ReturnType<typeof exportExactCanonicalOrderBook>
			>["levels"];
			summary: Awaited<
				ReturnType<typeof exportExactCanonicalOrderBook>
			>["summary"];
		}>;
	};
	cleanup(): Promise<void>;
};

export async function createMarketDataQualificationSandboxRuntime(input: {
	authorizationId: string;
	target: { environment: string; cluster: string };
}): Promise<MarketDataQualificationSandboxRuntime> {
	if (
		input.target.environment !== SOURCE_TAPE_SANDBOX_TARGET.environment ||
		input.target.cluster !== SOURCE_TAPE_SANDBOX_TARGET.cluster
	) {
		throw new Error("qualification_sandbox_target_mismatch");
	}
	const containerName = `cex-broker-qualification-${randomUUID()}`;
	const clickhousePassword = randomUUID();
	const forwarderToken = randomUUID();
	const outputDirectory = await mkdtemp(
		join(tmpdir(), "cex-source-tape-sandbox-export-"),
	);
	let containerStarted = false;
	let client: ClickHouseClient | undefined;
	let endpoint:
		| Awaited<ReturnType<typeof startArchiveForwarderEndpoint>>
		| undefined;
	try {
		await boundedCommand("docker", [
			"run",
			"-d",
			"--name",
			containerName,
			"--label",
			"cex-broker.market-data-qualification=true",
			"-e",
			`CLICKHOUSE_USER=${CLICKHOUSE_USER}`,
			"-e",
			`CLICKHOUSE_PASSWORD=${clickhousePassword}`,
			"-p",
			"127.0.0.1::8123",
			MARKET_DATA_QUALIFICATION_CLICKHOUSE_IMAGE,
		]);
		containerStarted = true;
		const [port, image] = await Promise.all([
			boundedCommand("docker", ["port", containerName, "8123/tcp"]),
			boundedCommand("docker", [
				"image",
				"inspect",
				"--format",
				"{{.Id}}",
				MARKET_DATA_QUALIFICATION_CLICKHOUSE_IMAGE,
			]),
		]);
		const portMatch = port.stdout.match(/:(\d+)\s*$/mu);
		if (!portMatch) throw new Error("qualification_sandbox_port_unavailable");
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
		if (version !== MARKET_DATA_QUALIFICATION_CLICKHOUSE_VERSION) {
			throw new Error("qualification_sandbox_clickhouse_version_mismatch");
		}
		await ensureArchiveSchema(client);
		const configuredAtMs = Date.now();
		const archiveIdentityContent = {
			singleton_key: "archive",
			environment: input.target.environment,
			cluster: input.target.cluster,
			configured_at_ms: configuredAtMs,
		};
		await client.insert({
			table: "market_data.cex_archive_cluster_identity",
			values: [
				{
					...archiveIdentityContent,
					configuration_sha256: jcsSha256(archiveIdentityContent),
				},
			],
			format: "JSONEachRow",
		});
		const archiveIdentity = await readArchiveClusterIdentity(client);
		if (!archiveIdentity) {
			throw new Error("qualification_sandbox_archive_identity_missing");
		}
		endpoint = await startArchiveForwarderEndpoint({
			inserter: createClickHouseInserter(client),
			authToken: forwarderToken,
			productionBackfill: {
				archiveIdentity,
				authorization: {
					authorizationId: input.authorizationId,
					scope: "production",
					environment: input.target.environment,
					cluster: input.target.cluster,
					expiresAt: new Date(configuredAtMs + 60 * 60 * 1_000).toISOString(),
				},
			},
		});
		const forwarderClient = createArchiveForwarderClient({
			url: endpoint.url,
			authToken: forwarderToken,
		});
		const preflight = await forwarderClient.preflight({
			authorizationId: input.authorizationId,
			target: input.target,
		});
		assertSourceTapeSandboxAuthorization({
			requestAuthorizationId: input.authorizationId,
			requestTarget: input.target,
			preflight: preflight.authorization,
		});
		const queryClient = createClickHouseArchiveQueryClient({
			url: clickhouseUrl,
			username: CLICKHOUSE_USER,
			password: clickhousePassword,
		});
		const reader = new QualifiedOrderBookArchiveReader(queryClient);
		const exportClient = createClickHouseExactOrderBookExportClient({
			url: clickhouseUrl,
			username: CLICKHOUSE_USER,
			password: clickhousePassword,
		});
		let cleaned = false;
		return {
			clickhouse: {
				image: MARKET_DATA_QUALIFICATION_CLICKHOUSE_IMAGE,
				imageId: image.stdout.trim(),
				version: MARKET_DATA_QUALIFICATION_CLICKHOUSE_VERSION,
			},
			outputDirectory,
			queryClient,
			forwarder: { submit: (batch) => forwarderClient.submit(batch) },
			archive: {
				async resolveSelection(request) {
					return (await reader.resolveSelection(request)).selection;
				},
			},
			exporter: {
				async export(request) {
					try {
						const exported = await exportExactCanonicalOrderBook({
							request,
							client: exportClient,
							outputDirectory,
						});
						return {
							promotionReceiptIds: exported.promotionReceiptIds,
							levels: exported.levels,
							summary: exported.summary,
						};
					} catch (error) {
						await Promise.all([
							rm(join(outputDirectory, "order_book_levels.parquet"), {
								force: true,
							}),
							rm(join(outputDirectory, "order_book_depth_summary.parquet"), {
								force: true,
							}),
						]);
						throw error;
					}
				},
			},
			async cleanup() {
				if (cleaned) return;
				cleaned = true;
				const failures: unknown[] = [];
				await endpoint?.close().catch((error) => failures.push(error));
				await client?.close().catch((error) => failures.push(error));
				await boundedCommand("docker", ["rm", "-f", containerName], true).catch(
					(error) => failures.push(error),
				);
				await rm(outputDirectory, { recursive: true, force: true }).catch(
					(error) => failures.push(error),
				);
				if (failures.length > 0) {
					throw new Error("qualification_sandbox_cleanup_failed");
				}
			},
		};
	} catch (error) {
		await endpoint?.close().catch(() => {});
		await client?.close().catch(() => {});
		if (containerStarted) {
			await boundedCommand("docker", ["rm", "-f", containerName], true).catch(
				() => {},
			);
		}
		await rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}
