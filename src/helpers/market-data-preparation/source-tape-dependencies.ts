import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createClickHouseArchiveQueryClient,
	QualifiedOrderBookArchiveReader,
} from "../market-data-vendor-backfill/archive-reader";
import { createArchiveForwarderClient } from "../market-data-vendor-backfill/forwarder-client";
import {
	type CanonicalOrderBookExportRequestWire,
	canonicalOrderBookExportResultCodec,
} from "./contracts";
import type { MarketDataSourceTapeDependencies } from "./source-tape-operation";

export type MarketDataSourceTapeDependencyConfiguration = {
	attemptRoot: string;
	archiveForwarder: {
		url: string;
		authToken?: string;
	};
	clickHouse: {
		url: string;
		username?: string;
		password?: string;
	};
};

type MarketDataSourceTapeDependencyRuntime = {
	exporterExecutablePath: string;
	nodeExecutablePath: string;
};

function assertExactObject(
	value: unknown,
	keys: readonly string[],
	reason: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(reason);
	}
	if (
		JSON.stringify(Object.keys(value).sort()) !==
		JSON.stringify([...keys].sort())
	) {
		throw new Error(reason);
	}
}

function assertClosedObject(
	value: unknown,
	keys: readonly string[],
	reason: string,
): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !keys.includes(key))
	) {
		throw new Error(reason);
	}
}

function requiredEndpoint(value: unknown, reason: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(reason);
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		throw new Error(reason);
	}
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw new Error(reason);
	}
	return value;
}

function optionalSecret(value: unknown, reason: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(reason);
	return value || undefined;
}

function decodeConfiguration(
	value: unknown,
): MarketDataSourceTapeDependencyConfiguration {
	assertExactObject(
		value,
		["attemptRoot", "archiveForwarder", "clickHouse"],
		"source_tape_dependency_configuration_invalid",
	);
	if (
		typeof value.attemptRoot !== "string" ||
		!path.isAbsolute(value.attemptRoot)
	) {
		throw new Error("source_tape_dependency_attempt_root_invalid");
	}
	let rootStats: ReturnType<typeof lstatSync>;
	try {
		rootStats = lstatSync(value.attemptRoot);
	} catch {
		throw new Error("source_tape_dependency_attempt_root_invalid");
	}
	if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
		throw new Error("source_tape_dependency_attempt_root_invalid");
	}
	assertClosedObject(
		value.archiveForwarder,
		["url", "authToken"],
		"source_tape_dependency_forwarder_invalid",
	);
	assertClosedObject(
		value.clickHouse,
		["url", "username", "password"],
		"source_tape_dependency_clickhouse_invalid",
	);
	return {
		attemptRoot: value.attemptRoot,
		archiveForwarder: {
			url: requiredEndpoint(
				value.archiveForwarder.url,
				"source_tape_dependency_forwarder_invalid",
			),
			authToken: optionalSecret(
				value.archiveForwarder.authToken,
				"source_tape_dependency_forwarder_invalid",
			),
		},
		clickHouse: {
			url: requiredEndpoint(
				value.clickHouse.url,
				"source_tape_dependency_clickhouse_invalid",
			),
			username: optionalSecret(
				value.clickHouse.username,
				"source_tape_dependency_clickhouse_invalid",
			),
			password: optionalSecret(
				value.clickHouse.password,
				"source_tape_dependency_clickhouse_invalid",
			),
		},
	};
}

function runExporter(input: {
	nodeExecutablePath: string;
	exporterExecutablePath: string;
	requestPath: string;
	resultPath: string;
	attemptRoot: string;
	environment: Record<string, string>;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			input.nodeExecutablePath,
			[
				input.exporterExecutablePath,
				"run",
				"--request",
				input.requestPath,
				"--result",
				input.resultPath,
			],
			{
				cwd: input.attemptRoot,
				env: input.environment,
				stdio: "ignore",
			},
		);
		child.once("error", () => {
			reject(new Error("source_tape_export_process_failed"));
		});
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error("source_tape_export_process_failed"));
		});
	});
}

export function createMarketDataSourceTapeDependenciesForRuntime(
	configuration: MarketDataSourceTapeDependencyConfiguration,
	runtime: MarketDataSourceTapeDependencyRuntime,
): MarketDataSourceTapeDependencies {
	const input = decodeConfiguration(configuration);
	const forwarder = createArchiveForwarderClient({
		url: input.archiveForwarder.url,
		authToken: input.archiveForwarder.authToken,
	});
	const archiveQuery = createClickHouseArchiveQueryClient({
		url: input.clickHouse.url,
		username: input.clickHouse.username,
		password: input.clickHouse.password,
	});
	const archiveReader = new QualifiedOrderBookArchiveReader(archiveQuery);
	const exporterEnvironment: Record<string, string> = {
		CLICKHOUSE_URL: input.clickHouse.url,
	};
	if (input.clickHouse.username) {
		exporterEnvironment.CLICKHOUSE_USER = input.clickHouse.username;
	}
	if (input.clickHouse.password) {
		exporterEnvironment.CLICKHOUSE_PASSWORD = input.clickHouse.password;
	}
	return {
		forwarder,
		archive_query: archiveQuery,
		archive: {
			async resolveSelection(request) {
				return (await archiveReader.resolveSelection(request)).selection;
			},
		},
		exporter: {
			async export(request: CanonicalOrderBookExportRequestWire) {
				const token = randomUUID();
				const requestPath = path.join(
					input.attemptRoot,
					`.source-tape-export-${token}-request.json`,
				);
				const resultPath = path.join(
					input.attemptRoot,
					`.source-tape-export-${token}-result.json`,
				);
				await writeFile(requestPath, `${JSON.stringify(request)}\n`, {
					flag: "wx",
					mode: 0o600,
				});
				try {
					await runExporter({
						nodeExecutablePath: runtime.nodeExecutablePath,
						exporterExecutablePath: runtime.exporterExecutablePath,
						requestPath,
						resultPath,
						attemptRoot: input.attemptRoot,
						environment: exporterEnvironment,
					});
					const result = canonicalOrderBookExportResultCodec.decode(
						JSON.parse(await readFile(resultPath, "utf8")),
					);
					const artifacts = result.outcome.artifacts;
					if (result.outcome.status !== "exported" || !artifacts) {
						throw new Error("source_tape_export_result_invalid");
					}
					return {
						promotionReceiptIds: result.outcome.promotion_receipt_ids,
						levels: artifacts.levels,
						summary: artifacts.summary,
						result,
					};
				} finally {
					await Promise.all([
						rm(requestPath, { force: true }),
						rm(resultPath, { force: true }),
					]);
				}
			},
		},
	};
}
