import { describe, expect, test } from "bun:test";
import {
	parseSidecarInvocation,
	SidecarUsageError,
	validateSidecarManifest,
} from "../scripts/archive-sidecar";

const sha = "a".repeat(40);

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
			makerSha: "b".repeat(40),
			baselineSha: "7a83de5f29a08f42d81f64a75a83bc9318dce94a",
			artifactsDir: "/tmp/a/run-a",
			manifestPath: "/tmp/a/run-a/manifest.json",
			statePath: "/tmp/a/run-a/state.json",
			logPath: "/tmp/a/run-a/supervisor.log",
			verificationPath: "/tmp/a/run-a/verification.json",
			spoolPath: "/tmp/a/run-a/strategy-spool.sqlite",
			containerName: "cex-sidecar-run-a",
			clickhouseUrl: "http://127.0.0.1:18123",
			forwarderUrl: "http://127.0.0.1:18090/archive",
			forwarderHealthUrl: "http://127.0.0.1:18090/health",
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
});
