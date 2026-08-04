import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";

const SOURCE = "broker_write";
const TABLE = "broker_stream_health.snapshots";
const PRODUCER_ID = "cex-broker-user-data";
const STATE_VERSION = 1;
const HEARTBEAT_MS = 30_000;
const FORWARDER_TIMEOUT_MS = 3_000;
const IDENTIFIER = /^[a-z0-9][a-z0-9:_-]{0,127}$/;

export type StreamHealthState =
	| "connecting"
	| "connected"
	| "disconnected"
	| "error";
export type StreamHealthFailureKind =
	| "none"
	| "auth_failed"
	| "transport_error"
	| "remote_closed"
	| "protocol_error"
	| "backpressure"
	| "unsupported_connector"
	| "shutdown";
export type StreamHealthSnapshot = {
	exchange: string;
	accountSelector: string;
	accountRole?: string;
	streamKind: "user_data";
	accountScope: "spot";
	registryStatus: "active" | "retired";
	retiredAt: string | null;
	state: StreamHealthState;
	stateChangedAt: string;
	lastConnectedAt: string | null;
	lastAuthenticatedAt: string | null;
	lastReceivedAt: string | null;
	connectAttemptCount: string;
	reconnectCount: string;
	errorCount: string;
	lastFailureKind: StreamHealthFailureKind;
	lastFailureReason: string;
	trafficMode: "event_driven" | "continuous" | "unknown";
	sourceWatermark: string | null;
};
type StateFile = {
	version: typeof STATE_VERSION;
	producerId: typeof PRODUCER_ID;
	producerEpoch: string;
	runId: string;
	nextBatchSequence: string;
	nextStreamSequences: Record<string, string>;
	pendingBody?: string;
};
export type StreamHealthPublisherOptions = {
	deploymentId: string;
	statePath: string;
	forwarderUrl: string;
	forwarderAuthToken?: string;
	heartbeatIntervalMs?: number;
	forwarderTimeoutMs?: number;
	post?: (body: string) => Promise<void>;
};

function identifier(value: string, name: string): string {
	const normalized = value.trim().toLowerCase();
	if (!IDENTIFIER.test(normalized)) {
		throw new Error(`${name} must be a lower-case stream-health identifier`);
	}
	return normalized;
}

function counter(value: string): bigint {
	if (!/^(0|[1-9]\d*)$/.test(value)) {
		throw new Error("Invalid persisted stream-health counter");
	}
	return BigInt(value);
}
function next(value: string): string {
	return (counter(value) + 1n).toString();
}
function key(snapshot: StreamHealthSnapshot): string {
	return `exchange:${snapshot.exchange}|account:${snapshot.accountSelector}|stream:${snapshot.streamKind}|scope:${snapshot.accountScope}`;
}
function registryRevision(snapshots: readonly StreamHealthSnapshot[]): string {
	const rows = snapshots
		.map((snapshot) => ({
			exchange: snapshot.exchange,
			account_selector: snapshot.accountSelector,
			account_role: snapshot.accountRole ?? null,
			stream_kind: snapshot.streamKind,
			account_scope: snapshot.accountScope,
			registry_status: snapshot.registryStatus,
		}))
		.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
	return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function validState(value: unknown): value is StateFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Partial<StateFile>;
	return (
		state.version === STATE_VERSION &&
		state.producerId === PRODUCER_ID &&
		typeof state.producerEpoch === "string" &&
		typeof state.runId === "string" &&
		typeof state.nextBatchSequence === "string" &&
		state.nextStreamSequences !== null &&
		typeof state.nextStreamSequences === "object" &&
		(state.pendingBody === undefined || typeof state.pendingBody === "string")
	);
}
function forwarderPost(
	url: URL,
	body: string,
	authToken: string | undefined,
	timeoutMs: number,
): Promise<void> {
	const request = url.protocol === "http:" ? httpRequest : httpsRequest;
	const headers: Record<string, string | number> = {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	};
	if (authToken) headers.authorization = `Bearer ${authToken}`;
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{ method: "POST", headers, timeout: timeoutMs },
			(res) => {
				res.on("data", () => {});
				res.on("end", () => {
					const status = res.statusCode ?? 0;
					if (status < 200 || status >= 300) {
						reject(new Error(`Stream health forwarder returned ${status}`));
						return;
					}
					resolve();
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () =>
			req.destroy(new Error("Stream health forwarder timed out")),
		);
		req.write(body);
		req.end();
	});
}

/** A whole health batch is persisted before POST so retries are exact replays. */
export class StreamHealthPublisher {
	readonly #deploymentId: string;
	readonly #statePath: string;
	readonly #heartbeatMs: number;
	readonly #post: (body: string) => Promise<void>;
	#state: StateFile;
	#advanceRun: boolean;
	#snapshots: readonly StreamHealthSnapshot[] = [];
	#dirty = false;
	#closed = false;
	#pumping: Promise<void> | null = null;
	#heartbeat: ReturnType<typeof setInterval> | null = null;
	#retry: ReturnType<typeof setTimeout> | null = null;
	#retryAttempt = 0;

	constructor(options: StreamHealthPublisherOptions) {
		this.#deploymentId = identifier(options.deploymentId, "deployment_id");
		this.#statePath = options.statePath.trim();
		if (!this.#statePath) {
			throw new Error("CEX_BROKER_STREAM_HEALTH_STATE_PATH is required");
		}
		this.#heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_MS;
		if (
			!Number.isInteger(this.#heartbeatMs) ||
			this.#heartbeatMs < 1 ||
			this.#heartbeatMs > 60_000
		) {
			throw new Error(
				"Stream health heartbeat interval must be between 1 and 60000ms",
			);
		}
		let url: URL;
		try {
			url = new URL(options.forwarderUrl.trim());
		} catch (error) {
			throw new Error("CEX_BROKER_ARCHIVE_FORWARDER_URL must be valid", {
				cause: error,
			});
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("CEX_BROKER_ARCHIVE_FORWARDER_URL must use HTTP(S)");
		}
		this.#post =
			options.post ??
			((body) =>
				forwarderPost(
					url,
					body,
					options.forwarderAuthToken,
					options.forwarderTimeoutMs ?? FORWARDER_TIMEOUT_MS,
				));
		const loaded = this.#read();
		this.#state = loaded ?? {
			version: STATE_VERSION,
			producerId: PRODUCER_ID,
			producerEpoch: "1",
			runId: randomUUID(),
			nextBatchSequence: "1",
			nextStreamSequences: {},
		};
		counter(this.#state.producerEpoch);
		counter(this.#state.nextBatchSequence);
		for (const value of Object.values(this.#state.nextStreamSequences))
			counter(value);
		this.#advanceRun = loaded !== null;
		if (!loaded) this.#persist();
	}

	start(): void {
		if (this.#closed || this.#heartbeat) return;
		this.#heartbeat = setInterval(() => {
			if (this.#snapshots.length > 0) {
				this.#dirty = true;
				this.#schedule();
			}
		}, this.#heartbeatMs);
		this.#heartbeat.unref?.();
		if (this.#state.pendingBody || this.#dirty) this.#schedule();
	}

	publish(snapshots: readonly StreamHealthSnapshot[]): void {
		if (this.#closed) return;
		this.#snapshots = snapshots.map((snapshot) => ({ ...snapshot }));
		this.#dirty = true;
		this.#schedule();
	}

	async close(
		snapshots: readonly StreamHealthSnapshot[],
		timeoutMs = FORWARDER_TIMEOUT_MS,
	): Promise<void> {
		if (this.#closed) return;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = null;
		if (this.#retry) clearTimeout(this.#retry);
		this.#retry = null;
		this.#snapshots = snapshots.map((snapshot) => ({ ...snapshot }));
		this.#dirty = this.#snapshots.length > 0;
		this.#schedule();
		await Promise.race([
			this.#waitForIdle(),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);
		this.#closed = true;
		if (this.#retry) clearTimeout(this.#retry);
		this.#retry = null;
	}

	#schedule(): void {
		if (this.#closed || this.#pumping) return;
		this.#pumping = this.#pump().finally(() => {
			this.#pumping = null;
			if (
				!this.#closed &&
				!this.#retry &&
				(this.#state.pendingBody || this.#dirty)
			)
				this.#schedule();
		});
	}
	async #pump(): Promise<void> {
		if (this.#state.pendingBody && !(await this.#deliver())) return;
		if (!this.#dirty || this.#snapshots.length === 0) return;
		if (this.#advanceRun) {
			this.#state.producerEpoch = next(this.#state.producerEpoch);
			this.#state.runId = randomUUID();
			this.#state.nextBatchSequence = "1";
			this.#state.nextStreamSequences = {};
			this.#advanceRun = false;
			this.#persist();
		}
		this.#dirty = false;
		this.#state.pendingBody = this.#body(this.#snapshots);
		this.#persist();
		await this.#deliver();
	}
	async #deliver(): Promise<boolean> {
		const body = this.#state.pendingBody;
		if (!body) return true;
		try {
			await this.#post(body);
			this.#state.pendingBody = undefined;
			this.#persist();
			this.#retryAttempt = 0;
			return true;
		} catch {
			this.#retryLater();
			return false;
		}
	}
	#body(snapshots: readonly StreamHealthSnapshot[]): string {
		const ordered = [...snapshots].sort((left, right) =>
			key(left).localeCompare(key(right)),
		);
		if (ordered.length === 0 || ordered.length > 1_000) {
			throw new Error(
				"Stream health requires between one and 1000 registry rows",
			);
		}
		const batchSequence = this.#state.nextBatchSequence;
		this.#state.nextBatchSequence = next(batchSequence);
		const heartbeatAt = new Date().toISOString();
		const active = ordered.filter(
			(snapshot) => snapshot.registryStatus === "active",
		).length;
		const rows = ordered.map((snapshot) => {
			const streamKey = key(snapshot);
			const sequence = this.#state.nextStreamSequences[streamKey] ?? "1";
			this.#state.nextStreamSequences[streamKey] = next(sequence);
			return {
				table: TABLE,
				row: {
					producer_id: PRODUCER_ID,
					producer_epoch: this.#state.producerEpoch,
					run_id: this.#state.runId,
					batch_sequence: batchSequence,
					batch_snapshot_count: String(ordered.length),
					batch_active_stream_count: String(active),
					registry_revision: registryRevision(ordered),
					registry_status: snapshot.registryStatus,
					retired_at: snapshot.retiredAt,
					exchange: snapshot.exchange,
					account_selector: snapshot.accountSelector,
					account_role: snapshot.accountRole ?? null,
					stream_kind: snapshot.streamKind,
					account_scope: snapshot.accountScope,
					sequence,
					state: snapshot.state,
					state_changed_at: snapshot.stateChangedAt,
					last_connected_at: snapshot.lastConnectedAt,
					last_authenticated_at: snapshot.lastAuthenticatedAt,
					last_received_at: snapshot.lastReceivedAt,
					heartbeat_at: heartbeatAt,
					connect_attempt_count: snapshot.connectAttemptCount,
					reconnect_count: snapshot.reconnectCount,
					error_count: snapshot.errorCount,
					last_failure_kind: snapshot.lastFailureKind,
					last_failure_reason: snapshot.lastFailureReason,
					traffic_mode: snapshot.trafficMode,
					source_watermark: snapshot.sourceWatermark,
				},
			};
		});
		return JSON.stringify({
			source: SOURCE,
			deployment_id: this.#deploymentId,
			rows,
		});
	}
	#retryLater(): void {
		if (this.#closed || this.#retry) return;
		const delay = Math.min(1_000 * 2 ** this.#retryAttempt, 30_000);
		this.#retryAttempt += 1;
		this.#retry = setTimeout(() => {
			this.#retry = null;
			this.#schedule();
		}, delay);
		this.#retry.unref?.();
	}
	async #waitForIdle(): Promise<void> {
		while (this.#pumping) await this.#pumping;
	}
	#read(): StateFile | null {
		try {
			const parsed = JSON.parse(
				readFileSync(this.#statePath, "utf8"),
			) as unknown;
			if (!validState(parsed)) throw new Error("invalid state shape");
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error("Stream health state cannot be read", { cause: error });
		}
	}
	#persist(): void {
		const parent = dirname(this.#statePath);
		try {
			if (!statSync(parent).isDirectory())
				throw new Error("state parent is not a directory");
		} catch (error) {
			throw new Error("Stream health state directory is unavailable", {
				cause: error,
			});
		}
		const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
		let fd: number | undefined;
		try {
			fd = openSync(temporary, "wx", 0o600);
			writeFileSync(fd, JSON.stringify(this.#state));
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			renameSync(temporary, this.#statePath);
			const parentFd = openSync(parent, "r");
			try {
				fsyncSync(parentFd);
			} finally {
				closeSync(parentFd);
			}
		} catch (error) {
			if (fd !== undefined) closeSync(fd);
			try {
				unlinkSync(temporary);
			} catch {}
			throw new Error("Stream health state cannot be persisted", {
				cause: error,
			});
		}
	}
}

export function streamHealthPublisherConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): StreamHealthPublisherOptions {
	if (env.CEX_BROKER_ARCHIVE_ENABLED !== "true") {
		throw new Error(
			"Configured account user streams require CEX_BROKER_ARCHIVE_ENABLED=true",
		);
	}
	const deploymentId = env.CEX_BROKER_DEPLOYMENT_ID?.trim();
	const forwarderUrl = env.CEX_BROKER_ARCHIVE_FORWARDER_URL?.trim();
	const statePath = env.CEX_BROKER_STREAM_HEALTH_STATE_PATH?.trim();
	if (!deploymentId || !forwarderUrl || !statePath) {
		throw new Error(
			"Configured account user streams require deployment, forwarder, and persistent state configuration",
		);
	}
	return {
		deploymentId,
		forwarderUrl,
		statePath,
		forwarderAuthToken:
			env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN?.trim() || undefined,
	};
}
