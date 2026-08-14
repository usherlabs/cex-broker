import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exchange } from "@usherlabs/ccxt";
import { validateStreamHealthArchiveBatch } from "../services/archive-forwarder/stream-health-contract";
import {
	StreamHealthPublisher,
	type StreamHealthSnapshot,
	streamHealthPublisherConfigFromEnv,
} from "../src/helpers/stream-health-publisher";
import { UserDataStreamSupervisor } from "../src/helpers/user-data-stream-supervisor";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function statePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "cex-broker-stream-health-"));
	directories.push(directory);
	return join(directory, "state.json");
}

function snapshot(
	overrides: Partial<StreamHealthSnapshot> = {},
): StreamHealthSnapshot {
	return {
		exchange: "binance",
		accountSelector: "primary",
		streamKind: "user_data",
		accountScope: "spot",
		registryStatus: "active",
		retiredAt: null,
		state: "connected",
		stateChangedAt: "2026-08-03T20:00:00.000Z",
		lastConnectedAt: "2026-08-03T20:00:00.000Z",
		lastAuthenticatedAt: "2026-08-03T20:00:01.000Z",
		lastReceivedAt: null,
		connectAttemptCount: "1",
		reconnectCount: "0",
		errorCount: "0",
		lastFailureKind: "none",
		lastFailureReason: "",
		trafficMode: "event_driven",
		sourceWatermark: null,
		...overrides,
	};
}

describe("stream health publisher", () => {
	test("publishes a complete quiet connected socket row accepted by the stream health contract", async () => {
		const sent: string[] = [];
		const publisher = new StreamHealthPublisher({
			deploymentId: "test-deployment",
			statePath: statePath(),
			forwarderUrl: "http://127.0.0.1:1/archive",
			post: async (body) => sent.push(body),
		});
		publisher.start();
		publisher.publish([snapshot()]);
		await publisher.close([snapshot()]);
		expect(sent.length).toBeGreaterThanOrEqual(1);
		const body = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
		const validation = validateStreamHealthArchiveBatch(body);
		expect(validation.ok).toBe(true);
		const row = (body.rows as Array<{ row: Record<string, unknown> }>)[0]?.row;
		expect(row?.stream_kind).toBe("user_data");
		expect(row?.last_received_at).toBeNull();
	});

	test("retries one byte-identical pending batch before a fresh current snapshot", async () => {
		const path = statePath();
		const attempts: string[] = [];
		let reachable = false;
		const publisher = new StreamHealthPublisher({
			deploymentId: "test-deployment",
			statePath: path,
			forwarderUrl: "http://127.0.0.1:1/archive",
			post: async (body) => {
				attempts.push(body);
				if (!reachable) throw new Error("forwarder unavailable");
			},
		});
		publisher.start();
		publisher.publish([snapshot()]);
		await Bun.sleep(10);
		const pending = JSON.parse(readFileSync(path, "utf8")) as {
			pendingBody?: string;
		};
		expect(pending.pendingBody).toBeDefined();
		reachable = true;
		await publisher.close([
			snapshot({
				errorCount: "1",
				lastFailureKind: "transport_error",
				lastFailureReason: "offline",
			}),
		]);
		expect(attempts[1]).toBe(attempts[0]);
		expect(attempts[0]).toBe(pending.pendingBody);
		expect(attempts.at(-1)).not.toBe(pending.pendingBody);
	});

	test("drains persisted old-run work before atomically advancing the run", async () => {
		const path = statePath();
		const pendingPublisher = new StreamHealthPublisher({
			deploymentId: "test-deployment",
			statePath: path,
			forwarderUrl: "http://127.0.0.1:1/archive",
			post: async () => {
				throw new Error("forwarder unavailable");
			},
		});
		pendingPublisher.start();
		pendingPublisher.publish([snapshot()]);
		await Bun.sleep(10);
		const oldPending = (
			JSON.parse(readFileSync(path, "utf8")) as { pendingBody: string }
		).pendingBody;
		const sent: string[] = [];
		const restarted = new StreamHealthPublisher({
			deploymentId: "test-deployment",
			statePath: path,
			forwarderUrl: "http://127.0.0.1:1/archive",
			post: async (body) => sent.push(body),
		});
		restarted.start();
		restarted.publish([
			snapshot({ lastReceivedAt: "2026-08-03T20:00:02.000Z" }),
		]);
		await restarted.close([
			snapshot({ lastReceivedAt: "2026-08-03T20:00:02.000Z" }),
		]);
		expect(sent[0]).toBe(oldPending);
		const oldRow = (
			JSON.parse(oldPending).rows[0] as { row: Record<string, unknown> }
		).row;
		const newRow = (
			JSON.parse(sent.at(-1) ?? "{}").rows[0] as {
				row: Record<string, unknown>;
			}
		).row;
		expect(newRow.producer_epoch).not.toBe(oldRow.producer_epoch);
		expect(newRow.run_id).not.toBe(oldRow.run_id);
	});

	test("requires archive and persistent state configuration for configured streams", () => {
		expect(() => streamHealthPublisherConfigFromEnv({})).toThrow(
			"CEX_BROKER_ARCHIVE_ENABLED",
		);
		expect(() =>
			streamHealthPublisherConfigFromEnv({
				CEX_BROKER_ARCHIVE_ENABLED: "true",
			}),
		).toThrow("deployment, forwarder, and persistent state");
	});

	test("keeps an unsupported configured connector in the complete health batch", async () => {
		const sent: string[] = [];
		const supervisor = new UserDataStreamSupervisor({
			brokers: {
				bybit: {
					primary: { exchange: {} as Exchange, label: "primary" },
					secondaryBrokers: [],
				},
			},
			publisher: new StreamHealthPublisher({
				deploymentId: "test-deployment",
				statePath: statePath(),
				forwarderUrl: "http://127.0.0.1:1/archive",
				post: async (body) => sent.push(body),
			}),
		});
		supervisor.start();
		await Bun.sleep(10);
		await supervisor.close();
		const first = JSON.parse(sent[0] ?? "{}") as {
			rows?: Array<{ row?: Record<string, unknown> }>;
		};
		expect(first.rows?.[0]?.row).toMatchObject({
			exchange: "bybit",
			state: "error",
			last_failure_kind: "unsupported_connector",
		});
	});
});
