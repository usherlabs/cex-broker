import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	createBackfillDependenciesFromEnv,
	runMarketDataVendorBackfillFileJob,
} from "../src/commands/market-data-vendor-backfill";
import { CONFORMANCE_FIXTURES } from "../src/helpers/market-data-vendor-backfill/conformance-fixtures";
import type { BackfillDependencies } from "../src/helpers/market-data-vendor-backfill/core";

const NOW_MS = Date.parse("2026-08-20T12:00:03.000Z");
const RELEASE = {
	packageVersion: "0.2.47",
	gitHead: "a".repeat(40),
};

async function createAttempt(
	request: string | object = CONFORMANCE_FIXTURES.documents.request,
) {
	const root = await mkdtemp(path.join(os.tmpdir(), "cex-backfill-command-"));
	const requestPath = path.join(root, "request.json");
	const resultPath = path.join(root, "result.json");
	const executablePath = path.join(root, "market-data-vendor-backfill.js");
	await writeFile(
		requestPath,
		typeof request === "string" ? request : JSON.stringify(request),
	);
	await writeFile(
		path.join(root, "required-clock.json"),
		JSON.stringify(CONFORMANCE_FIXTURES.documents.required_clock),
	);
	await writeFile(executablePath, "test executable bytes");
	return { root, requestPath, resultPath, executablePath };
}

function alreadyCoveredDependencies(): BackfillDependencies {
	return {
		archive: {
			async resolveSelection() {
				return {
					selection: CONFORMANCE_FIXTURES.documents.archive_selection,
					receipts: [CONFORMANCE_FIXTURES.documents.promotion_receipt],
					readerIdentity: {
						environment: "production",
						cluster: "cex-archive-primary",
					},
				};
			},
			async verifyCandidate() {
				throw new Error("must not verify an already-covered request");
			},
		},
		providers: {
			capabilityFor() {
				throw new Error("must not probe provider capability");
			},
			async acquire() {
				throw new Error("must not acquire vendor data");
			},
			async normalize() {
				throw new Error("must not normalize vendor data");
			},
		},
		credentials: {
			async resolve() {
				throw new Error("must not resolve vendor credentials");
			},
		},
		forwarder: {
			async preflight(input) {
				return {
					forwarderIdentity: input.target,
					authorization: {
						authorizationId: input.authorizationId,
						scope: "production",
						environment: input.target.environment,
						cluster: input.target.cluster,
						expiresAt: "2026-08-20T13:00:00.000Z",
						credentialValidated: true,
					},
				};
			},
			async submit() {
				throw new Error("must not submit already-covered data");
			},
		},
		clock: { nowMs: () => NOW_MS },
	};
}

describe("market-data-vendor-backfill command", () => {
	test("writes a CEX-owned v2 already-covered result with its self hash", async () => {
		const attempt = await createAttempt();
		try {
			const result = await runMarketDataVendorBackfillFileJob({
				...attempt,
				release: RELEASE,
				dependencies: alreadyCoveredDependencies(),
				nowMs: () => NOW_MS,
				randomUuid: () => "018f0f4d-7b32-7a30-8f4d-1d2a6e40f120",
			});
			expect(result.outcome.status).toBe("already_covered");
			expect(result.producer).toEqual({
				product_id: "market-data-vendor-backfill",
				product_version: "market-data-vendor-backfill/v1",
				package: {
					name: "@usherlabs/cex-broker",
					version: "0.2.47",
					git_head: RELEASE.gitHead,
				},
				executable_sha256: createHash("sha256")
					.update("test executable bytes")
					.digest("hex"),
				runtime: { name: "node", version: process.versions.node },
			});
			const onDisk = JSON.parse(await readFile(attempt.resultPath, "utf8"));
			expect(onDisk.result_sha256).toBe(result.result_sha256);
			expect(JSON.stringify(onDisk)).not.toContain("fiet_tee_commit");
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
		}
	});

	test("invalid JSON is handled before dependency construction", async () => {
		const attempt = await createAttempt("{not-json\n");
		try {
			let dependencyConstructions = 0;
			const result = await runMarketDataVendorBackfillFileJob({
				...attempt,
				release: RELEASE,
				createDependencies() {
					dependencyConstructions += 1;
					return alreadyCoveredDependencies();
				},
			});
			expect(result.outcome.status).toBe("request_invalid");
			expect(result.request_file_sha256).toBe(
				createHash("sha256").update("{not-json\n").digest("hex"),
			);
			expect(dependencyConstructions).toBe(0);
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
		}
	});

	test("environment construction uses a closed allowlist and resolves vendor credentials lazily", async () => {
		const accessed = new Set<string>();
		const values: Record<string, string> = {
			CLICKHOUSE_URL: "http://clickhouse.test",
			CLICKHOUSE_USER: "archive-user",
			CLICKHOUSE_PASSWORD: "archive-password",
			CEX_BROKER_ARCHIVE_FORWARDER_URL: "http://forwarder.test",
			CEX_BROKER_ARCHIVE_FORWARDER_TOKEN: "forwarder-token",
			CRYPTOHFTDATA_API_KEY: "vendor-key",
			VAULT_TOKEN: "must-not-read",
			ATTEST_URL: "must-not-read",
		};
		const environment = new Proxy(values, {
			get(target, property, receiver) {
				if (typeof property === "string") accessed.add(property);
				return Reflect.get(target, property, receiver);
			},
		});
		const sensitiveValues = new Set<string>();
		const dependencies = createBackfillDependenciesFromEnv(
			environment,
			sensitiveValues,
		);
		expect(accessed.has("CRYPTOHFTDATA_API_KEY")).toBe(false);
		expect(accessed.has("VAULT_TOKEN")).toBe(false);
		expect(await dependencies.credentials.resolve("cryptohftdata")).toEqual({
			apiKey: "vendor-key",
		});
		expect(sensitiveValues).toEqual(
			new Set(["archive-password", "forwarder-token", "vendor-key"]),
		);
		expect(accessed.has("VAULT_TOKEN")).toBe(false);
		expect(accessed.has("ATTEST_URL")).toBe(false);
	});
});
