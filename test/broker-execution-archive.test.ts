import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	closeSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord } from "@opentelemetry/api-logs";
import type { Exchange } from "@usherlabs/ccxt";
import { MAX_ARCHIVE_BODY_BYTES } from "../services/archive-forwarder/limits";
import type { ExecuteActionContext } from "../src/handlers/execute-action/context";
import { handleDeposit } from "../src/handlers/execute-action/deposit";
import { handleInternalTransfer } from "../src/handlers/execute-action/internal-transfer";
import { handleOrders } from "../src/handlers/execute-action/orders";
import { handleTreasuryCall } from "../src/handlers/execute-action/treasury-call";
import { handleWithdraw } from "../src/handlers/execute-action/withdraw";
import {
	redactSecretLiterals,
	redactStreamPayload,
} from "../src/helpers/broker-execution-archive/redact";
import {
	buildAccountBalanceSnapshotRow,
	buildCommonArchiveTags,
	buildFillEventArchiveRow,
	buildMarketMetadataSnapshotRow,
	buildOrderEventArchiveRow,
	buildSubscribeStreamArchiveRow,
	buildTransferEventArchiveRow,
	buildUserAssetSnapshotRow,
	normalizeBinanceUserAssetsForArchive,
	normalizeCcxtBalanceForArchive,
	normalizeCcxtTradeForArchive,
	normalizeCcxtTransactionForArchive,
} from "../src/helpers/broker-execution-archive/rows";
import {
	DEFAULT_WITHDRAWAL_OBSERVATION_TRACKER_MAX_ENTRIES,
	WithdrawalObservationTracker,
} from "../src/helpers/broker-execution-archive/withdrawal-observation-tracker";
import {
	BrokerExecutionArchiveDurabilityError,
	BrokerExecutionArchiver,
	createBrokerExecutionArchiverFromEnv,
	isArchiveOtelLogsEnabled,
	isBrokerExecutionArchiveTable,
	resolveArchiveForwarderUrlFromEnv,
	resolveArchiveSourceFromEnv,
	rethrowArchiveDurabilityError,
} from "../src/helpers/broker-execution-archive/writer";
import { Action } from "../src/helpers/constants";
import { log } from "../src/helpers/logger";
import { buildOrderExecutionTelemetry } from "../src/helpers/order-telemetry";
import type { OtelLogs } from "../src/helpers/otel";
import type { PolicyConfig } from "../src/types";
import { startForwarderServer } from "./archive-forwarder-server";

const archiveTestDirectory = mkdtempSync(
	join(tmpdir(), "cex-broker-archive-test-"),
);
let deadLetterFileIndex = 0;

function createDeadLetterPath(): string {
	deadLetterFileIndex += 1;
	return join(archiveTestDirectory, `loss-${deadLetterFileIndex}.jsonl`);
}

function readDeadLetters(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterAll(() => {
	rmSync(archiveTestDirectory, { recursive: true, force: true });
});

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = original;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
	condition: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) {
			throw new Error("condition did not become true before the deadline");
		}
		await delay(5);
	}
}

type RawArchiveServerMode = "stream" | "abort" | "close" | "success";

type RawArchiveServer = {
	url: string;
	requests: Array<{ body: Record<string, unknown> }>;
	setMode: (mode: RawArchiveServerMode) => void;
	waitForAccepted: (count?: number) => Promise<void>;
	waitForResponseClose: (count?: number) => Promise<void>;
	close: () => Promise<void>;
};

function startRawArchiveServer(
	initialMode: RawArchiveServerMode,
): Promise<RawArchiveServer> {
	let mode = initialMode;
	let acceptedCount = 0;
	let responseClosedCount = 0;
	const requests: Array<{ body: Record<string, unknown> }> = [];
	const acceptedWaiters: Array<{
		count: number;
		resolve: () => void;
	}> = [];
	const responseCloseWaiters: Array<{
		count: number;
		resolve: () => void;
	}> = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
		let abortTimer: ReturnType<typeof setTimeout> | undefined;
		let remoteClosed = false;
		const markResponseClosed = () => {
			if (remoteClosed) {
				return;
			}
			remoteClosed = true;
			if (keepAliveTimer) {
				clearInterval(keepAliveTimer);
				keepAliveTimer = undefined;
			}
			if (abortTimer) {
				clearTimeout(abortTimer);
				abortTimer = undefined;
			}
			responseClosedCount += 1;
			for (const waiter of responseCloseWaiters.splice(0)) {
				if (responseClosedCount >= waiter.count) {
					waiter.resolve();
				} else {
					responseCloseWaiters.push(waiter);
				}
			}
		};
		res.once("close", markResponseClosed);
		req.once("close", markResponseClosed);
		res.on("error", () => {});
		req.on("error", () => {});
		req.on("data", (chunk) => chunks.push(chunk as Buffer));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			requests.push({
				body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
			});
			acceptedCount += 1;
			for (const waiter of acceptedWaiters.splice(0)) {
				if (acceptedCount >= waiter.count) {
					waiter.resolve();
				} else {
					acceptedWaiters.push(waiter);
				}
			}

			if (mode === "stream") {
				res.writeHead(200, { "content-type": "application/json" });
				res.write("partial");
				keepAliveTimer = setInterval(() => {
					if (!res.destroyed) {
						res.write("keep-alive");
					}
				}, 5);
				return;
			}
			if (mode === "close") {
				req.socket?.destroy();
				return;
			}
			if (mode === "abort") {
				res.writeHead(200, { "content-type": "application/json" });
				res.write("partial");
				abortTimer = setTimeout(() => res.destroy(), 5);
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}/archive`,
				requests,
				setMode: (nextMode) => {
					mode = nextMode;
				},
				waitForAccepted: (count = 1) =>
					acceptedCount >= count
						? Promise.resolve()
						: new Promise((waiterResolve) => {
								acceptedWaiters.push({ count, resolve: waiterResolve });
							}),
				waitForResponseClose: (count = 1) =>
					responseClosedCount >= count
						? Promise.resolve()
						: new Promise((waiterResolve) => {
								responseCloseWaiters.push({ count, resolve: waiterResolve });
							}),
				close: () =>
					new Promise<void>((closeResolve) => {
						server.closeAllConnections?.();
						server.close(() => closeResolve());
					}),
			});
		});
	});
}

type CapturedArchiveMetric = {
	kind: "counter" | "gauge" | "observable_gauge";
	name: string;
	value: number;
	labels: Record<string, string | number>;
};

class CapturingArchiveMetrics {
	readonly calls: CapturedArchiveMetric[] = [];

	async recordCounter(
		name: string,
		value: number,
		labels: Record<string, string | number>,
	): Promise<void> {
		this.calls.push({ kind: "counter", name, value, labels });
	}

	async recordGauge(
		name: string,
		value: number,
		labels: Record<string, string | number>,
	): Promise<void> {
		this.calls.push({ kind: "gauge", name, value, labels });
	}

	async setObservableGauge(
		name: string,
		value: number,
		labels: Record<string, string | number>,
	): Promise<void> {
		this.calls.push({ kind: "observable_gauge", name, value, labels });
	}

	asOtelMetrics(): OtelMetrics {
		return this as unknown as OtelMetrics;
	}
}

class MockOtelLogs implements OtelLogs {
	readonly emits: LogRecord[] = [];

	isOtelEnabled(): boolean {
		return true;
	}

	emit(record: LogRecord): void {
		this.emits.push(record);
	}

	async close(): Promise<void> {}
}

describe("broker execution archive redaction", () => {
	test("redacts secret literals and credential-shaped keys from stream payloads", () => {
		const redacted = redactStreamPayload(
			{
				apiKey: "super-secret-key",
				orderId: "123",
				nested: { signature: "abc", status: "FILLED" },
			},
			["super-secret-key"],
		);

		expect(redacted.apiKey).toBe("[redacted]");
		expect(redacted.orderId).toBe("123");
		expect(redacted.nested).toEqual({
			signature: "[redacted]",
			status: "FILLED",
		});
		expect(JSON.stringify(redacted)).not.toContain("super-secret-key");
	});

	test("redacts secret literals in diagnostic strings", () => {
		const message = redactSecretLiterals(
			'apiKey=live-key-123 and "secret":"hidden"',
			["live-key-123"],
		);
		expect(message).not.toContain("live-key-123");
		expect(message).toContain("[redacted]");
	});
});

describe("broker execution archive rows", () => {
	test("builds one coherent spot balance row without reducing venue total for locked capital", () => {
		const balance = normalizeCcxtBalanceForArchive({
			timestamp: 1_784_000_000_123,
			free: { USDC: 80, BTC: 0.00000001 },
			used: { USDC: 20, BTC: 0 },
			total: { USDC: 100, BTC: 0.00000001 },
			USDC: { free: 80, used: 20, total: 100 },
			BTC: { free: 0.00000001, used: 0, total: 0.00000001 },
		});
		const row = buildAccountBalanceSnapshotRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				accountSelector: "secondary:2",
				exchange: "binance",
				brokerObservedTimestamp: "2026-07-14T12:00:00.000Z",
			}),
			balance,
		});

		expect(row.table).toBe("broker_account.balance_snapshots");
		expect(row.row).toMatchObject({
			broker_observed_timestamp: "2026-07-14T12:00:00.000Z",
			exchange_timestamp: new Date(1_784_000_000_123).toISOString(),
			source: "broker_write",
			deployment_id: "deploy-a",
			schema_version: "1",
			exchange: "binance",
			account_selector: "secondary:2",
			balance_scope: "spot",
			reported_assets: ["BTC", "USDC"],
			asset_entry_assets: ["BTC", "USDC"],
			free_balances: { BTC: "0.00000001", USDC: "80" },
			used_balances: { BTC: "0", USDC: "20" },
			total_balances: { BTC: "0.00000001", USDC: "100" },
			aggregate_free_map_present: 1,
			aggregate_used_map_present: 1,
			aggregate_total_map_present: 1,
			precision_basis: "ccxt_normalized_number",
		});
		expect(row.row.observation_id).toMatch(/^[a-f0-9]{64}$/);
		expect(row.row).not.toHaveProperty("payload_json");
	});

	test("preserves sparse map and reported-asset semantics without inventing zeros", () => {
		const normalized = normalizeCcxtBalanceForArchive({
			used: { USDC: 0, DOGE: null },
			total: { BTC: 2, XRP: "1.2300" },
			ETH: { free: 1, total: 1 },
		});

		expect(normalized).toEqual({
			exchangeTimestamp: undefined,
			reportedAssets: ["BTC", "DOGE", "ETH", "USDC", "XRP"],
			assetEntryAssets: ["ETH"],
			freeBalances: { ETH: "1" },
			usedBalances: { USDC: "0" },
			totalBalances: { BTC: "2", ETH: "1" },
			freeMapPresent: false,
			usedMapPresent: true,
			totalMapPresent: true,
		});
		expect(normalized.freeBalances).not.toHaveProperty("BTC");
		expect(normalized.totalBalances).not.toHaveProperty("USDC");
		expect(normalized.totalBalances).not.toHaveProperty("XRP");
		expect(normalized.usedBalances).not.toHaveProperty("DOGE");
	});

	test("excludes secrets and unfiltered info while keeping the row body bounded", () => {
		const secret = "live-api-secret";
		const normalized = normalizeCcxtBalanceForArchive({
			free: { USDC: 1 },
			used: {},
			total: { USDC: 1 },
			info: {
				apiKey: secret,
				raw: "x".repeat(6 * 1024 * 1024),
			},
		});
		const row = buildAccountBalanceSnapshotRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				accountSelector: "primary",
				exchange: "binance",
				brokerObservedTimestamp: "2026-07-14T12:00:00.000Z",
			}),
			balance: normalized,
		});
		const serialized = JSON.stringify(row);

		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain('"info"');
		expect(Buffer.byteLength(serialized)).toBeLessThan(2_000);
	});

	test("keeps a default 10-row batch of 800-asset snapshots below the forwarder body limit", () => {
		const assets = Array.from(
			{ length: 800 },
			(_, index) => `ASSET_${index.toString().padStart(4, "0")}`,
		);
		const free = Object.fromEntries(
			assets.map((asset, index) => [asset, index + 0.125]),
		);
		const used = Object.fromEntries(
			assets.map((asset, index) => [asset, index + 0.25]),
		);
		const total = Object.fromEntries(
			assets.map((asset, index) => [asset, index * 2 + 0.375]),
		);
		const response: Record<string, unknown> = { free, used, total };
		for (const asset of assets) {
			response[asset] = {
				free: free[asset],
				used: used[asset],
				total: total[asset],
			};
		}
		const balance = normalizeCcxtBalanceForArchive(response);
		const rows = Array.from({ length: 10 }, (_, index) =>
			buildAccountBalanceSnapshotRow({
				tags: buildCommonArchiveTags({
					deploymentId: "deploy-a",
					accountSelector: "primary",
					exchange: "binance",
					brokerObservedTimestamp: new Date(
						Date.UTC(2026, 6, 14, 12, index),
					).toISOString(),
				}),
				balance,
			}),
		);
		const envelope = JSON.stringify({
			source: "broker_write",
			deployment_id: "deploy-a",
			rows,
		});

		expect(balance.reportedAssets).toHaveLength(800);
		expect(rows).toHaveLength(10);
		expect(Buffer.byteLength(envelope)).toBeLessThan(MAX_ARCHIVE_BODY_BYTES);
	});

	test("derives a stable observation id from the complete normalized observation", () => {
		const balance = normalizeCcxtBalanceForArchive({ total: { USDC: 1 } });
		const tags = buildCommonArchiveTags({
			deploymentId: "deploy-a",
			accountSelector: "primary",
			exchange: "binance",
			brokerObservedTimestamp: "2026-07-14T12:00:00.000Z",
		});
		const first = buildAccountBalanceSnapshotRow({ tags, balance });
		const second = buildAccountBalanceSnapshotRow({ tags, balance });

		expect(first.row.observation_id).toBe(second.row.observation_id);
	});

	test("exposes the travel-rule freeze bucket as its own column with venue-raw quantities", () => {
		const userAssets = normalizeBinanceUserAssetsForArchive([
			{
				asset: "USDC",
				free: "12.34000000",
				locked: "0",
				freeze: "118.50000000",
				withdrawing: "0",
				ipoable: "0",
				btcValuation: "0.00000000",
			},
		]);
		const row = buildUserAssetSnapshotRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				accountSelector: "primary",
				exchange: "binance",
				brokerObservedTimestamp: "2026-08-12T12:00:00.000Z",
			}),
			userAssets,
		});

		expect(row.table).toBe("broker_account.user_asset_snapshots");
		expect(row.row).toMatchObject({
			broker_observed_timestamp: "2026-08-12T12:00:00.000Z",
			source: "broker_write",
			deployment_id: "deploy-a",
			schema_version: "1",
			exchange: "binance",
			account_selector: "primary",
			balance_scope: "user_asset",
			reported_assets: ["USDC"],
			incomplete_assets: [],
			// Venue strings kept verbatim, never re-rendered through a JS number.
			free_balances: { USDC: "12.34000000" },
			locked_balances: { USDC: "0" },
			freeze_balances: { USDC: "118.50000000" },
			withdrawing_balances: { USDC: "0" },
			precision_basis: "venue_raw_string",
		});
		expect(row.row.observation_id).toMatch(/^[a-f0-9]{64}$/);
		// The endpoint carries no venue timestamp; none is invented.
		expect(row.row).not.toHaveProperty("exchange_timestamp");
	});

	test("reports an unreadable bucket as unknown rather than as zero", () => {
		const userAssets = normalizeBinanceUserAssetsForArchive([
			{ asset: "USDC", free: "1", locked: "0", withdrawing: "0" },
			{ asset: "BTC", free: "0", locked: "0", freeze: "", withdrawing: "0" },
		]);

		expect(userAssets.incompleteAssets).toEqual(["BTC", "USDC"]);
		expect(userAssets.reportedAssets).toEqual(["BTC", "USDC"]);
		expect(userAssets.freezeBalances).toEqual({});
		expect(userAssets.freeBalances).toEqual({ BTC: "0", USDC: "1" });
	});

	test("fails closed on a getUserAsset response whose owned quantity cannot be accounted for", () => {
		expect(() => normalizeBinanceUserAssetsForArchive({ assets: [] })).toThrow(
			"binance_user_asset_malformed_response",
		);
		expect(() =>
			normalizeBinanceUserAssetsForArchive([{ free: "1", freeze: "2" }]),
		).toThrow("binance_user_asset_malformed_response");
		expect(() =>
			normalizeBinanceUserAssetsForArchive([
				{ asset: "USDC", freeze: "1" },
				{ asset: "USDC", freeze: "2" },
			]),
		).toThrow("binance_user_asset_malformed_response");
	});

	test("derives a stable user-asset observation id from the complete normalized observation", () => {
		const userAssets = normalizeBinanceUserAssetsForArchive([
			{ asset: "USDC", free: "1", locked: "0", freeze: "0", withdrawing: "0" },
		]);
		const tags = buildCommonArchiveTags({
			deploymentId: "deploy-a",
			accountSelector: "primary",
			exchange: "binance",
			brokerObservedTimestamp: "2026-08-12T12:00:00.000Z",
		});

		expect(
			buildUserAssetSnapshotRow({ tags, userAssets }).row.observation_id,
		).toBe(buildUserAssetSnapshotRow({ tags, userAssets }).row.observation_id);
	});

	test("builds order event rows tagged for broker_execution.order_events", () => {
		const telemetry = buildOrderExecutionTelemetry(
			{
				action: "CancelOrder",
				cex: "binance",
				accountLabel: "primary",
				symbol: "ARB/USDT",
				orderAuthor: "maker-alpha",
				clientOrderId: "client-1",
				makerActionId: "maker-1",
			},
			{ id: "99", status: "canceled", symbol: "ARB/USDT", side: "sell" },
		);
		const row = buildOrderEventArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				accountSelector: "primary",
				exchange: "binance",
				symbol: "ARB/USDT",
			}),
			action: "CancelOrder",
			telemetry,
		});

		expect(row.table).toBe("broker_execution.order_events");
		expect(row.row).toMatchObject({
			source: "broker_write",
			deployment_id: "deploy-a",
			account_selector: "primary",
			exchange: "binance",
			action: "CancelOrder",
			event_kind: "execute_action",
			order_id: "99",
			order_author: "maker-alpha",
			client_order_id: "client-1",
			maker_action_id: "maker-1",
		});
		expect(String(row.row.payload_json)).not.toContain("apiSecret");
	});

	test("builds subscribe stream rows without leaking secrets", () => {
		const row = buildSubscribeStreamArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				exchange: "binance",
				symbol: "ARB/USDT",
			}),
			subscriptionType: "ORDERS",
			streamPayload: {
				e: "executionReport",
				i: 42,
				c: "client-1",
				apiSecret: "must-not-appear",
			},
		});

		expect(row.row.event_kind).toBe("subscribe_stream");
		expect(row.row.subscription_type).toBe("ORDERS");
		expect(JSON.stringify(row.row)).not.toContain("must-not-appear");
	});

	test("omits absent optional join keys so they insert as NULL, not empty string", () => {
		const telemetry = buildOrderExecutionTelemetry(
			{
				action: "CreateOrder",
				cex: "binance",
				accountLabel: "primary",
				symbol: "ARB/USDT",
			},
			{ status: "new", symbol: "ARB/USDT", side: "buy" },
		);
		const orderRow = buildOrderEventArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				exchange: "binance",
				symbol: "ARB/USDT",
			}),
			action: "CreateOrder",
			telemetry,
		});
		// Absent identifiers must be OMITTED from the payload (not "") so the
		// Nullable(String) columns receive NULL and never spuriously join on ''.
		for (const key of [
			"order_id",
			"client_order_id",
			"idempotency_id",
			"maker_action_id",
			"market_metadata_hash",
		]) {
			expect(orderRow.row).not.toHaveProperty(key);
		}
		expect(orderRow.row.order_author).toBe("");

		const snapshotRow = buildMarketMetadataSnapshotRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				exchange: "binance",
				symbol: "ARB/USDT",
			}),
			marketSnapshot: { bids: [], asks: [] },
		});
		for (const key of [
			"client_order_id",
			"order_id",
			"maker_action_id",
			"idempotency_id",
		]) {
			expect(snapshotRow.row).not.toHaveProperty(key);
		}
		// A snapshot always computes its content hash, so it is always present.
		expect(snapshotRow.row).toHaveProperty("market_metadata_hash");
	});

	test("builds transfer event rows in the contract column shape", () => {
		const row = buildTransferEventArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				accountSelector: "primary",
				exchange: "binance",
				symbol: "USDC",
			}),
			transfer: {
				eventKind: "withdrawal",
				lifecycleAction: "submit_withdrawal",
				status: "ok",
				amount: "100",
				address: "0xdead",
				network: "ARBITRUM",
				externalId: "wd-1",
				clientWithdrawalId: "lane-withdrawal-1",
				txid: "0xabc",
				feeAmount: "4.89",
				feeCurrency: "USDC",
				payload: { id: "wd-1" },
			},
		});

		expect(row.table).toBe("broker_execution.transfer_events");
		expect(row.row).toMatchObject({
			source: "broker_write",
			deployment_id: "deploy-a",
			account_selector: "primary",
			exchange: "binance",
			symbol: "USDC",
			// asset_symbol mirrors the shared symbol tag for transfers, per contract.
			asset_symbol: "USDC",
			schema_version: "1",
			event_kind: "withdrawal",
			lifecycle_action: "submit_withdrawal",
			status: "ok",
			amount: "100",
			external_id: "wd-1",
			client_withdrawal_id: "lane-withdrawal-1",
			result_index: 0,
			// Additive columns (ccxt exposes the withdrawal fee).
			fee_amount: "4.89",
			fee_currency: "USDC",
		});
	});

	test("transfer rows keep the read-key columns present when ids are absent", () => {
		const row = buildTransferEventArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				exchange: "binance",
				symbol: "USDC",
			}),
			transfer: {
				eventKind: "deposit",
				lifecycleAction: "observe_deposit",
				payload: {},
			},
		});
		expect(row.row.external_id).toBe("");
		expect(row.row.client_withdrawal_id).toBe("");
		expect(row.row.status).toBe("");
		expect(row.row.result_index).toBe(0);
		expect(row.row.event_kind).toBe("deposit");
	});

	test("normalizeCcxtTransactionForArchive captures the withdrawal fee as a string", () => {
		const normalized = normalizeCcxtTransactionForArchive({
			id: "wd-1",
			txid: "0xabc",
			address: "0xdead",
			currency: "USDC",
			amount: 100,
			status: "ok",
			network: "ARBITRUM",
			fee: { cost: 4.89, currency: "USDC" },
			datetime: "2026-07-04T00:00:00.000Z",
		});
		expect(normalized).toMatchObject({
			externalId: "wd-1",
			txid: "0xabc",
			address: "0xdead",
			network: "ARBITRUM",
			amount: "100",
			assetSymbol: "USDC",
			status: "ok",
			feeAmount: "4.89",
			feeCurrency: "USDC",
			exchangeTimestamp: "2026-07-04T00:00:00.000Z",
		});
	});

	test("normalizeCcxtTransactionForArchive prefers the venue raw string amount", () => {
		const normalized = normalizeCcxtTransactionForArchive({
			amount: 7.5,
			info: { amount: "7.50000000" },
			fee: { cost: 0.1 },
		});
		// Venue precision preserved over ccxt's parsed number.
		expect(normalized.amount).toBe("7.50000000");
	});

	test("normalizeCcxtTransactionForArchive preserves an explicit zero fee", () => {
		const normalized = normalizeCcxtTransactionForArchive({
			fee: { cost: 0, currency: "USDC" },
		});
		expect(normalized.feeAmount).toBe("0");
		expect(normalized.feeCurrency).toBe("USDC");
	});

	test("builds fill event rows in the contract column shape", () => {
		const row = buildFillEventArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				accountSelector: "primary",
				exchange: "binance",
				symbol: "USDC/USDT",
			}),
			fill: {
				...normalizeCcxtTradeForArchive({
					id: "t-1",
					order: "o-1",
					clientOrderId: "c-1",
					side: "BUY",
					type: "limit",
					price: 1.0,
					amount: 50,
					cost: 50,
					fee: { cost: 0.05, currency: "USDC", rate: 0.001 },
					timestamp: 1_700_000_000_000,
				}),
				fillIndex: 2,
			},
		});

		expect(row.table).toBe("broker_execution.fill_events");
		expect(row.row).toMatchObject({
			symbol: "USDC/USDT",
			schema_version: "1",
			// Honest provenance: trade-history poller, not createOrder trades[].
			event_kind: "trade_history_fill",
			order_id: "o-1",
			client_order_id: "c-1",
			fill_id: "t-1",
			fill_index: 2,
			side: "buy",
			order_type: "limit",
			price: "1",
			base_quantity: "50",
			quote_quantity: "50",
			fee_amount: "0.05",
			fee_currency: "USDC",
			fee_rate: "0.001",
		});
	});

	test("fill rows default order_id/fill_index (contract read keys) when the venue omits them", () => {
		const row = buildFillEventArchiveRow({
			tags: buildCommonArchiveTags({
				deploymentId: "deploy-a",
				exchange: "binance",
				symbol: "USDC/USDT",
			}),
			fill: normalizeCcxtTradeForArchive({ price: 1 }),
		});
		expect(row.row.order_id).toBe("");
		expect(row.row.fill_index).toBe(0);
	});

	// Guards the fiet-maker CEX_EXECUTION_ARCHIVE_CONTRACT: a fully-populated row must
	// carry every consumer-required column so the sandbox proof harness queries hold.
	test("transfer/fill rows cover every consumer-contract column", () => {
		const CONTRACT_TRANSFER_COLUMNS = [
			"broker_observed_timestamp",
			"source",
			"deployment_id",
			"schema_version",
			"account_selector",
			"exchange",
			"symbol",
			"event_kind",
			"lifecycle_action",
			"status",
			"asset_symbol",
			"amount",
			"address",
			"network",
			"external_id",
			"txid",
			"result_index",
			"exchange_timestamp",
			"error_summary",
			"payload_json",
		];
		const CONTRACT_FILL_COLUMNS = [
			"broker_observed_timestamp",
			"source",
			"deployment_id",
			"schema_version",
			"account_selector",
			"exchange",
			"symbol",
			"event_kind",
			"order_id",
			"client_order_id",
			"fill_id",
			"fill_index",
			"side",
			"order_type",
			"price",
			"base_quantity",
			"quote_quantity",
			"fee_amount",
			"fee_currency",
			"fee_rate",
			"exchange_timestamp",
			"payload_json",
		];
		const tags = buildCommonArchiveTags({
			deploymentId: "deploy-a",
			accountSelector: "secondary:1",
			exchange: "binance",
			symbol: "USDC",
		});
		const transferRow = buildTransferEventArchiveRow({
			tags,
			transfer: {
				eventKind: "withdrawal",
				lifecycleAction: "submit_withdrawal",
				status: "ok",
				amount: "7.5",
				address: "0xwallet",
				network: "ARBITRUM",
				externalId: "wd-1",
				txid: "0xabc",
				resultIndex: 0,
				feeAmount: "0.1",
				feeCurrency: "USDC",
				exchangeTimestamp: "2026-07-04T00:00:00.000Z",
				errorSummary: "",
				payload: {},
			},
		}).row;
		for (const column of CONTRACT_TRANSFER_COLUMNS) {
			expect(transferRow).toHaveProperty(column);
		}
		const fillRow = buildFillEventArchiveRow({
			tags,
			fill: {
				orderId: "o-1",
				clientOrderId: "c-1",
				fillId: "t-1",
				fillIndex: 0,
				side: "buy",
				orderType: "limit",
				price: "1",
				baseQuantity: "5",
				quoteQuantity: "5",
				feeAmount: "0.01",
				feeCurrency: "USDC",
				feeRate: "0.001",
				exchangeTimestamp: "2026-07-04T00:00:00.000Z",
				payload: {},
			},
		}).row;
		for (const column of CONTRACT_FILL_COLUMNS) {
			expect(fillRow).toHaveProperty(column);
		}
	});
});

describe("order author archive plumbing", () => {
	test("archives authors from typed and Call createOrder without forwarding them to the venue", async () => {
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: createDeadLetterPath(),
			deploymentId: "test-deploy",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const createOrderCalls: unknown[][] = [];
		const broker = {
			loadMarkets: async () => {},
			markets: {
				"USDC/USDT": {
					symbol: "USDC/USDT",
					base: "USDC",
					quote: "USDT",
					spot: true,
					type: "spot",
				},
			},
			createOrder: async (...args: unknown[]) => {
				createOrderCalls.push(args);
				return {
					id: `order-${createOrderCalls.length}`,
					symbol: args[0],
					type: args[1],
					side: args[2],
					amount: args[3],
					status: "open",
					filled: 0,
				};
			},
		} as unknown as Exchange;
		const policy = {
			order: { rule: { markets: ["*"], limits: [] } },
		} as unknown as PolicyConfig;
		const context = (
			action: (typeof Action)[keyof typeof Action],
			payload: Record<string, unknown>,
		) =>
			({
				action,
				call: { request: { payload } },
				wrappedCallback: () => {},
				policy,
				brokers: {},
				normalizedCex: "binance",
				cex: "binance",
				symbol: "USDC/USDT",
				selectedBrokerAccount: { exchange: broker, label: "primary" },
				broker,
				verity: { proof: "" },
				brokerArchiver: archiver,
			}) as unknown as ExecuteActionContext;
		const typedPayload = (orderAuthor?: string) => ({
			orderType: "limit",
			amount: "10",
			fromToken: "USDC",
			toToken: "USDT",
			price: "1",
			marketType: "spot",
			...(orderAuthor !== undefined && { orderAuthor }),
			params: JSON.stringify({ timeInForce: "GTC" }),
		});

		try {
			await handleOrders(
				context(Action.CreateOrder, typedPayload("maker-alpha")),
			);
			await handleTreasuryCall(
				context(Action.Call, {
					functionName: "createOrder",
					args: JSON.stringify(["USDC/USDT", "limit", "buy", 5, 1]),
					orderAuthor: "funding-executor",
					params: JSON.stringify({ postOnly: true }),
				}),
			);
			await handleOrders(context(Action.CreateOrder, typedPayload()));

			expect(createOrderCalls[0]?.[5]).toEqual({ timeInForce: "GTC" });
			expect(createOrderCalls[1]?.[5]).toEqual({ postOnly: true });
			expect(createOrderCalls[2]?.[5]).toEqual({ timeInForce: "GTC" });
			for (const call of createOrderCalls) {
				expect(call[5]).not.toHaveProperty("orderAuthor");
			}

			await Promise.resolve();
			await archiver.flush();
			const orderRows = forwarder.requests
				.flatMap((request) => request.body.rows ?? [])
				.filter(
					(entry) => entry.table === "broker_execution.order_events",
				) as Array<{ row: Record<string, unknown> }>;
			const orderAuthors = Object.fromEntries(
				orderRows.map(({ row }) => [row.order_id, row.order_author]),
			);

			expect(orderAuthors).toEqual({
				"order-1": "maker-alpha",
				"order-2": "funding-executor",
				"order-3": "",
			});
		} finally {
			await archiver.close();
			await forwarder.close();
		}
	});
});

describe("withdrawal observation tracker", () => {
	function shouldArchive(
		tracker: WithdrawalObservationTracker,
		transaction: Record<string, unknown>,
	): boolean {
		return tracker.shouldArchive({
			exchange: "binance",
			accountSelector: "primary",
			assetSymbol: "USDC",
			transaction,
			normalized: normalizeCcxtTransactionForArchive(transaction),
		});
	}

	test("suppresses identical records and captures every fingerprint field change", () => {
		const baseline = {
			id: "wd-1",
			txid: "tx-1",
			currency: "USDC",
			status: "pending",
			amount: "10",
			fee: { cost: "0", currency: "USDC" },
			datetime: "2026-07-01T00:00:00.000Z",
			info: { completeTime: "" },
		};
		const changedRecords = [
			{ ...baseline, status: "ok" },
			{ ...baseline, txid: "tx-2" },
			{ ...baseline, amount: "11" },
			{ ...baseline, fee: { cost: "1", currency: "USDC" } },
			{ ...baseline, fee: { cost: "0", currency: "USDT" } },
			{ ...baseline, address: "0xrecipient" },
			{ ...baseline, network: "ARBITRUM" },
			{ ...baseline, info: { completeTime: "2026-07-01T00:01:00Z" } },
		];

		for (const changed of changedRecords) {
			const tracker = new WithdrawalObservationTracker();
			expect(shouldArchive(tracker, baseline)).toBe(true);
			expect(shouldArchive(tracker, { ...baseline })).toBe(false);
			expect(shouldArchive(tracker, changed)).toBe(true);
		}
	});

	test("uses non-colliding identities when the venue omits ids", () => {
		const tracker = new WithdrawalObservationTracker({ maxEntries: 2 });
		const unidentified = {
			currency: "USDC",
			status: "pending",
			amount: "10",
		};

		expect(shouldArchive(tracker, unidentified)).toBe(true);
		expect(shouldArchive(tracker, { ...unidentified })).toBe(true);
		expect(tracker.getSize()).toBe(2);
	});

	test("evicts the oldest identity at the configured bound and permits replay", () => {
		const tracker = new WithdrawalObservationTracker({ maxEntries: 2 });
		const transaction = (id: string) => ({
			id,
			currency: "USDC",
			status: "pending",
			amount: "10",
		});

		expect(shouldArchive(tracker, transaction("wd-1"))).toBe(true);
		expect(shouldArchive(tracker, transaction("wd-2"))).toBe(true);
		expect(shouldArchive(tracker, transaction("wd-3"))).toBe(true);
		expect(tracker.getSize()).toBe(2);
		expect(shouldArchive(tracker, transaction("wd-1"))).toBe(true);
		expect(tracker.getSize()).toBe(2);
	});

	test("falls back to the default bound for non-finite capacity overrides", () => {
		for (const maxEntries of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const tracker = new WithdrawalObservationTracker({ maxEntries });
			for (
				let index = 0;
				index <= DEFAULT_WITHDRAWAL_OBSERVATION_TRACKER_MAX_ENTRIES;
				index += 1
			) {
				shouldArchive(tracker, {
					id: `wd-${index}`,
					currency: "USDC",
					status: "pending",
					amount: "10",
				});
			}
			expect(tracker.getSize()).toBe(
				DEFAULT_WITHDRAWAL_OBSERVATION_TRACKER_MAX_ENTRIES,
			);
		}
	});
});

describe("withdraw submission archive", () => {
	test("carries valid caller ids on successful and failed submissions without deriving invalid ids", async () => {
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: createDeadLetterPath(),
			deploymentId: "test-deploy",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const broker = {
			has: { fetchCurrencies: false },
			currencies: {
				USDC: {
					networks: {
						BSC: { id: "BSC", network: "BSC" },
					},
				},
			},
			withdraw: async (
				_code: string,
				_amount: number,
				_address: string,
				_tag: undefined,
				params: Record<string, unknown>,
			) => {
				if (params.withdrawOrderId === "failed-lane") {
					throw new Error("venue rejected withdrawal");
				}
				return { id: "venue-withdrawal-id" };
			},
		} as unknown as Exchange;

		const context = (withdrawOrderId: string | number) =>
			({
				call: {
					request: {
						payload: {
							recipientAddress: "0xrecipient",
							amount: "10",
							chain: "BNB",
							params: JSON.stringify({ withdrawOrderId }),
						},
					},
				},
				wrappedCallback: () => {},
				policy: {
					withdraw: {
						rule: [
							{
								exchange: "BINANCE",
								network: "BNB",
								whitelist: ["0xrecipient"],
								coins: ["USDC"],
							},
						],
					},
					deposit: {},
					order: { rule: { markets: [], limits: [] } },
				},
				brokers: {},
				metadata: {},
				normalizedCex: "binance",
				cex: "binance",
				symbol: "USDC",
				selectedBrokerAccount: { exchange: broker, label: "primary" },
				broker,
				verity: { proof: "" },
				applyVerityToBroker: () => {},
				useVerity: false,
				verityProverUrl: "",
				brokerArchiver: archiver,
			}) as unknown as ExecuteActionContext;

		try {
			await handleWithdraw(context("successful-lane"));
			await handleWithdraw(context("failed-lane"));
			await handleWithdraw(context(123));
			await Promise.resolve();
			await archiver.flush();

			const rows = forwarder.requests.flatMap(
				(request) => request.body.rows ?? [],
			) as Array<{ row: Record<string, unknown> }>;
			expect(rows).toHaveLength(3);
			expect(rows[0]?.row).toMatchObject({
				external_id: "venue-withdrawal-id",
				client_withdrawal_id: "successful-lane",
				status: "",
			});
			expect(rows[1]?.row).toMatchObject({
				external_id: "",
				client_withdrawal_id: "failed-lane",
				status: "failed",
				error_summary: "venue rejected withdrawal",
			});
			expect(rows[2]?.row.client_withdrawal_id).toBe("");
		} finally {
			await archiver.close();
			await forwarder.close();
		}
	});
});

describe("internal transfer submission archive", () => {
	test("indexes Binance venue ids for every internal transfer direction", async () => {
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: createDeadLetterPath(),
			deploymentId: "test-deploy",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		const exchangeBase = {
			loadMarkets: async () => {},
			currency: (code: string) => ({ id: code }),
			currencyToPrecision: (_code: string, amount: number) => String(amount),
		};
		const primaryExchange = {
			...exchangeBase,
			sapiPostSubAccountUniversalTransfer: async () => ({
				tranId: "primary-to-sub-id",
			}),
		} as unknown as Exchange;
		const secondaryExchange = {
			...exchangeBase,
			sapiPostSubAccountTransferSubToMaster: async () => ({
				txnId: "sub-to-master-id",
			}),
			sapiPostSubAccountTransferSubToSub: async () => ({
				txnId: "sub-to-sub-id",
			}),
		} as unknown as Exchange;
		const brokers = {
			binance: {
				primary: { exchange: primaryExchange, label: "primary" as const },
				secondaryBrokers: [
					{
						exchange: secondaryExchange,
						label: "secondary:1" as const,
						index: 1,
					},
					{
						exchange: secondaryExchange,
						label: "secondary:2" as const,
						index: 2,
						email: "secondary-2@example.com",
					},
				],
			},
		};
		const context = (fromAccount: string, toAccount: string) =>
			({
				call: {
					request: {
						payload: { amount: "10", fromAccount, toAccount },
					},
				},
				wrappedCallback: () => {},
				brokers,
				metadata: {},
				normalizedCex: "binance",
				cex: "binance",
				symbol: "USDC",
				broker: primaryExchange,
				verity: { proof: "" },
				useVerity: false,
				verityProverUrl: "",
				brokerArchiver: archiver,
			}) as unknown as ExecuteActionContext;

		try {
			await handleInternalTransfer(context("secondary:1", "primary"));
			await handleInternalTransfer(context("secondary:1", "secondary:2"));
			await handleInternalTransfer(context("primary", "secondary:2"));
			await Promise.resolve();
			await archiver.flush();

			const rows = forwarder.requests.flatMap(
				(request) => request.body.rows ?? [],
			) as Array<{ row: Record<string, unknown> }>;
			expect(rows).toHaveLength(3);
			expect(
				rows.map(({ row }) => ({
					from: row.account_selector,
					to: (JSON.parse(String(row.payload_json)) as { to: string }).to,
					externalId: row.external_id,
					status: row.status,
					amount: row.amount,
				})),
			).toEqual([
				{
					from: "secondary:1",
					to: "primary",
					externalId: "sub-to-master-id",
					status: "ok",
					amount: "10",
				},
				{
					from: "secondary:1",
					to: "secondary:2",
					externalId: "sub-to-sub-id",
					status: "ok",
					amount: "10",
				},
				{
					from: "primary",
					to: "secondary:2",
					externalId: "primary-to-sub-id",
					status: "ok",
					amount: "10",
				},
			]);
		} finally {
			await archiver.close();
			await forwarder.close();
		}
	});
});

describe("broker execution archiver queue", () => {
	test("classifies only broker_execution tables for the OTel mirror", () => {
		for (const table of [
			"broker_execution.order_events",
			"broker_execution.market_metadata_snapshots",
			"broker_execution.transfer_events",
			"broker_execution.fill_events",
		] as const) {
			expect(isBrokerExecutionArchiveTable(table)).toBe(true);
		}
		expect(
			isBrokerExecutionArchiveTable("broker_account.balance_snapshots"),
		).toBe(false);
		expect(isBrokerExecutionArchiveTable("market_data.candles")).toBe(false);
	});

	test("classifies and rethrows only archive durability failures", () => {
		const durabilityError = new BrokerExecutionArchiveDurabilityError(
			"loss journal write failed",
		);
		expect(() => rethrowArchiveDurabilityError(durabilityError)).toThrow(
			durabilityError,
		);
		expect(() =>
			rethrowArchiveDurabilityError(new Error("ordinary capture failure")),
		).not.toThrow();
	});

	test("creates loss journals as owner-only without chmodding existing files", async () => {
		const newPath = createDeadLetterPath();
		const created = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			deadLetterPath: newPath,
			flushIntervalMs: 60_000,
		});
		expect(statSync(newPath).mode & 0o777).toBe(0o600);
		await created.close();

		const existingPath = createDeadLetterPath();
		writeFileSync(existingPath, "");
		chmodSync(existingPath, 0o640);
		const existing = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			deadLetterPath: existingPath,
			flushIntervalMs: 60_000,
		});
		await existing.close();
		expect(statSync(existingPath).mode & 0o777).toBe(0o640);
	});

	test("retains the oldest queued row when loss journaling fails", async () => {
		const deadLetterPath = createDeadLetterPath();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			deadLetterPath,
			maxQueueSize: 1,
			batchSize: 10,
			flushIntervalMs: 60_000,
		});
		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { order_id: "oldest" },
		});

		const deadLetterFd = Reflect.get(archiver, "deadLetterFd");
		expect(typeof deadLetterFd).toBe("number");
		closeSync(deadLetterFd as number);

		expect(() =>
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { order_id: "new" },
			}),
		).toThrow(BrokerExecutionArchiveDurabilityError);
		expect(archiver.getQueueDepth()).toBe(1);
		expect(archiver.getStats().shed).toBe(0);

		// The retention assertion is complete; clear the private queue only to let
		// close exercise and release the deliberately invalidated file handle.
		(Reflect.get(archiver, "queue") as unknown[]).length = 0;
		let closeError: unknown;
		try {
			await archiver.close();
		} catch (error) {
			closeError = error;
		}
		expect(closeError).toBeInstanceOf(BrokerExecutionArchiveDurabilityError);
		expect((closeError as Error).message).toContain(
			"CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH",
		);
		expect((closeError as Error).message).not.toContain(deadLetterPath);
	});

	test("posts JSON with the bearer token over the real node:http transport", async () => {
		const server = await startForwarderServer();
		const originalToken = process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN;
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN = "secret-token";

		try {
			const archiver = BrokerExecutionArchiver.create({
				source: "broker_read",
				forwarderUrl: server.url,
				deadLetterPath: createDeadLetterPath(),
				deploymentId: "test-deploy",
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});

			await archiver.flush();

			expect(server.requests).toHaveLength(1);
			const request = server.requests[0];
			expect(request?.method).toBe("POST");
			expect(request?.headers["content-type"]).toBe("application/json");
			expect(request?.headers.authorization).toBe("Bearer secret-token");
			expect(request?.body).toMatchObject({
				source: "broker_read",
				deployment_id: "test-deploy",
				rows: [
					{
						table: "broker_execution.order_events",
						row: { source: "broker_read", order_id: "1" },
					},
				],
			});
			expect(archiver.getSource()).toBe("broker_read");

			await archiver.close();
		} finally {
			await server.close();
			if (originalToken === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN;
			} else {
				process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN = originalToken;
			}
		}
	});

	test("queue shedding journals the oldest row before discarding it", async () => {
		const server = await startForwarderServer();
		try {
			const otelLogs = new MockOtelLogs();
			const deadLetterPath = createDeadLetterPath();
			const archiver = BrokerExecutionArchiver.create({
				source: "broker_read",
				forwarderUrl: server.url,
				deadLetterPath,
				otelLogs,
				deploymentId: "test-deploy",
				maxQueueSize: 2,
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "2" },
			});
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "3" },
			});

			expect(archiver.getStats().shed).toBe(1);
			expect(archiver.getQueueDepth()).toBe(2);
			const [loss] = readDeadLetters(deadLetterPath);
			expect(loss).toMatchObject({
				source: "broker_read",
				deployment_id: "test-deploy",
				reason: "queue_shed",
				payload: {
					table: "broker_execution.order_events",
					row: { source: "broker_read", order_id: "1" },
				},
			});
			expect(new Date(String(loss?.timestamp)).toISOString()).toBe(
				loss?.timestamp,
			);

			await archiver.flush();
			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.body.rows).toHaveLength(2);
			expect(otelLogs.emits).toHaveLength(2);

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("mirrors only broker_execution rows to OTel logs and forwards every archive table", async () => {
		const server = await startForwarderServer();
		try {
			const otelLogs = new MockOtelLogs();
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deadLetterPath: createDeadLetterPath(),
				otelLogs,
				deploymentId: "test-deploy",
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: {
					source: "broker_write",
					order_id: "1",
					error_message: "sensitive exchange rejection",
				},
			});
			archiver.enqueue({
				table: "market_data.orderbook_snapshots",
				row: { source: "broker_write", best_bid: 100 },
			});
			archiver.enqueue({
				table: "broker_account.balance_snapshots",
				row: { source: "broker_write", reported_assets: ["USDC"] },
			});

			await archiver.flush();

			// Only execution rows mirror to OTel (market_data has no OTel schema)...
			expect(otelLogs.emits).toHaveLength(1);
			expect(otelLogs.emits[0]?.body).toBe("broker_execution.order_events");
			expect(otelLogs.emits[0]?.attributes?.error_message).toBe(
				"redacted_error",
			);
			// ...but the forwarder is the durable sink for both tables.
			expect(server.requests).toHaveLength(1);
			const forwardedRows = server.requests.flatMap((request) =>
				Array.isArray(request.body.rows) ? request.body.rows : [],
			) as Array<{ table?: string; row?: Record<string, unknown> }>;
			expect(forwardedRows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ table: "broker_execution.order_events" }),
					expect.objectContaining({ table: "market_data.orderbook_snapshots" }),
					expect.objectContaining({
						table: "broker_account.balance_snapshots",
					}),
				]),
			);
			expect(
				forwardedRows.find(
					(entry) => entry.table === "broker_execution.order_events",
				)?.row?.error_message,
			).toBe("sensitive exchange rejection");

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("close journals every row left after a forwarder failure", async () => {
		const server = await startForwarderServer(() => ({ status: 503 }));
		try {
			const deadLetterPath = createDeadLetterPath();
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deadLetterPath,
				deploymentId: "test-deploy",
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "market_data.candles",
				row: { source: "broker_write", open_time_ms: 1_000 },
			});
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "shutdown-order" },
			});

			await expect(archiver.close()).resolves.toBeUndefined();
			expect(archiver.getQueueDepth()).toBe(0);
			expect(archiver.getStats().forwarderFailures).toBeGreaterThan(0);
			expect(readDeadLetters(deadLetterPath)).toEqual([
				expect.objectContaining({
					deployment_id: "test-deploy",
					reason: "shutdown_forwarder_failure",
					payload: {
						table: "market_data.candles",
						row: { source: "broker_write", open_time_ms: 1_000 },
					},
				}),
				expect.objectContaining({
					deployment_id: "test-deploy",
					reason: "shutdown_forwarder_failure",
					payload: {
						table: "broker_execution.order_events",
						row: {
							source: "broker_write",
							order_id: "shutdown-order",
						},
					},
				}),
			]);
		} finally {
			await server.close();
		}
	});

	test("requeues the whole batch after a forwarder network failure", async () => {
		// Abort the socket so the client's node:http request errors — the network
		// failure path (distinct from the non-2xx path exercised elsewhere).
		const server = await startForwarderServer(() => ({ destroy: true }));
		try {
			const otelLogs = new MockOtelLogs();
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deadLetterPath: createDeadLetterPath(),
				otelLogs,
				deploymentId: "test-deploy",
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});
			archiver.enqueue({
				table: "market_data.candles",
				row: { source: "broker_write", open_time_ms: 1_000 },
			});

			await archiver.flush();
			// The execution row still reached OTel (mirror happens before the post),
			// and both rows are requeued for a later forwarder retry — neither is lost.
			expect(otelLogs.emits).toHaveLength(1);
			expect(archiver.getQueueDepth()).toBe(2);
			expect(server.requests).toHaveLength(1);

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("posts broker_execution rows to the forwarder even without OTel logs", async () => {
		const server = await startForwarderServer();
		try {
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deadLetterPath: createDeadLetterPath(),
				deploymentId: "test-deploy",
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});

			await archiver.flush();
			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.body).toMatchObject({
				rows: expect.arrayContaining([
					expect.objectContaining({ table: "broker_execution.order_events" }),
				]),
			});

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("keeps the queue within maxQueueSize when a failed batch is requeued after refill", async () => {
		// Gate the forwarder so a batch stays in flight while new rows refill the
		// queue, then fail it — the classic over-cap window for the requeue path.
		let releasePost: () => void = () => {};
		const postGate = new Promise<void>((resolve) => {
			releasePost = resolve;
		});
		const server = await startForwarderServer(async () => {
			await postGate;
			return { status: 503 };
		});
		try {
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deadLetterPath: createDeadLetterPath(),
				deploymentId: "test-deploy",
				maxQueueSize: 3,
				batchSize: 4, // above the 3 rows we enqueue, so only manual flush drains
				flushIntervalMs: 60_000,
			});
			const row = (id: string) =>
				({
					table: "broker_execution.order_events",
					row: { source: "broker_write", order_id: id },
				}) as const;

			archiver.enqueue(row("1"));
			archiver.enqueue(row("2"));
			archiver.enqueue(row("3"));

			// Splices [1,2,3] out and blocks on the gated forwarder response.
			const flushPromise = archiver.flush();
			expect(archiver.getQueueDepth()).toBe(0);

			// Queue refills to the cap while the batch is in flight.
			archiver.enqueue(row("4"));
			archiver.enqueue(row("5"));
			archiver.enqueue(row("6"));
			expect(archiver.getQueueDepth()).toBe(3);

			releasePost();
			await flushPromise;

			// Without bound enforcement this would be 6 (3 refill + 3 requeued).
			expect(archiver.getQueueDepth()).toBe(3);
			expect(archiver.getStats().shed).toBeGreaterThanOrEqual(3);

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("bounds a response that stays open despite socket activity and retries without loss", async () => {
		const server = await startRawArchiveServer("stream");
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: server.url,
			deadLetterPath: createDeadLetterPath(),
			batchSize: 10,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 40,
		});
		const row = {
			table: "broker_execution.order_events" as const,
			row: { order_id: "streaming-response" },
		};

		try {
			archiver.enqueue(row);
			let settlementCount = 0;
			const firstFlush = archiver.flush();
			const observedFirstFlush = firstFlush.then(
				() => {
					settlementCount += 1;
				},
				() => {
					settlementCount += 1;
				},
			);
			await server.waitForAccepted();
			const settledBeforeDeadline = await Promise.race([
				observedFirstFlush.then(() => true),
				delay(160).then(() => false),
			]);
			expect(settledBeforeDeadline).toBe(true);
			expect(settlementCount).toBe(1);
			expect(
				await Promise.race([
					server.waitForResponseClose().then(() => true),
					delay(160).then(() => false),
				]),
			).toBe(true);
			expect(archiver.getQueueDepth()).toBe(1);
			expect(archiver.getStats().shed).toBe(0);
			expect(
				archiver.getHealthSnapshot().oldest_pending_age_ms,
			).toBeGreaterThanOrEqual(35);

			server.setMode("success");
			const retryFlush = archiver.flush();
			expect(retryFlush).not.toBe(firstFlush);
			await retryFlush;
			expect(archiver.getQueueDepth()).toBe(0);
			expect(server.requests).toHaveLength(2);
			expect(server.requests[0]?.body.rows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						table: row.table,
						row: expect.objectContaining(row.row),
					}),
				]),
			);
			expect(server.requests[1]?.body.rows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						table: row.table,
						row: expect.objectContaining(row.row),
					}),
				]),
			);

			await delay(80);
			expect(settlementCount).toBe(1);
		} finally {
			await server.close();
			await archiver.close();
		}
	});

	test("settles a response that aborts after headers and retries without loss", async () => {
		const server = await startRawArchiveServer("abort");
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: server.url,
			deadLetterPath: createDeadLetterPath(),
			batchSize: 10,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 100,
		});
		const originalSetTimeout = globalThis.setTimeout;
		const outerDeadlineTimers: Array<ReturnType<typeof setTimeout>> = [];
		const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
			(callback, delayMs, ...args) => {
				const handle = originalSetTimeout(callback, delayMs, ...args);
				if (delayMs === 100) {
					outerDeadlineTimers.push(handle);
				}
				return handle;
			},
		);
		const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
		const row = {
			table: "market_data.candles" as const,
			row: { open_time_ms: 1_000 },
		};

		try {
			archiver.enqueue(row);
			let settlementCount = 0;
			const firstFlush = archiver.flush();
			const observedFirstFlush = firstFlush.then(
				() => {
					settlementCount += 1;
				},
				() => {
					settlementCount += 1;
				},
			);
			await server.waitForAccepted();
			expect(
				await Promise.race([
					observedFirstFlush.then(() => true),
					delay(160).then(() => false),
				]),
			).toBe(true);
			expect(settlementCount).toBe(1);
			expect(outerDeadlineTimers).toHaveLength(1);
			expect(clearTimeoutSpy.mock.calls).toContainEqual([
				outerDeadlineTimers[0],
			]);
			expect(
				await Promise.race([
					server.waitForResponseClose().then(() => true),
					delay(160).then(() => false),
				]),
			).toBe(true);
			expect(archiver.getQueueDepth()).toBe(1);
			expect(archiver.getStats().shed).toBe(0);

			server.setMode("success");
			const retryFlush = archiver.flush();
			expect(retryFlush).not.toBe(firstFlush);
			await retryFlush;
			expect(archiver.getQueueDepth()).toBe(0);
			expect(server.requests).toHaveLength(2);
			expect(server.requests[1]?.body.rows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						table: row.table,
						row: expect.objectContaining(row.row),
					}),
				]),
			);
		} finally {
			clearTimeoutSpy.mockRestore();
			setTimeoutSpy.mockRestore();
			await server.close();
			await archiver.close();
		}
	});

	test("settles a pre-header connection close and retries without loss", async () => {
		const server = await startRawArchiveServer("close");
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: server.url,
			deadLetterPath: createDeadLetterPath(),
			batchSize: 10,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 100,
		});
		const row = {
			table: "broker_execution.order_events" as const,
			row: { order_id: "pre-header-close" },
		};

		try {
			archiver.enqueue(row);
			let settlementCount = 0;
			const firstFlush = archiver.flush();
			const observedFirstFlush = firstFlush.then(
				() => {
					settlementCount += 1;
				},
				() => {
					settlementCount += 1;
				},
			);
			await server.waitForAccepted();
			expect(
				await Promise.race([
					observedFirstFlush.then(() => true),
					delay(160).then(() => false),
				]),
			).toBe(true);
			expect(settlementCount).toBe(1);
			expect(
				await Promise.race([
					server.waitForResponseClose().then(() => true),
					delay(160).then(() => false),
				]),
			).toBe(true);
			expect(archiver.getQueueDepth()).toBe(1);
			expect(archiver.getStats().shed).toBe(0);

			server.setMode("success");
			const retryFlush = archiver.flush();
			expect(retryFlush).not.toBe(firstFlush);
			await retryFlush;
			expect(archiver.getQueueDepth()).toBe(0);
			expect(server.requests).toHaveLength(2);
			expect(server.requests[1]?.body.rows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						table: row.table,
						row: expect.objectContaining(row.row),
					}),
				]),
			);
			await delay(80);
			expect(settlementCount).toBe(1);
		} finally {
			await server.close();
			await archiver.close();
		}
	});

	test("reports failed current health before shedding and recovers after a fresh persisted batch", async () => {
		let status = 503;
		const server = await startForwarderServer(() => ({ status }));
		const metrics = new CapturingArchiveMetrics();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: server.url,
			deadLetterPath: createDeadLetterPath(),
			batchSize: 10,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 100,
			maxQueueSize: 2,
			otelMetrics: metrics.asOtelMetrics(),
		});

		try {
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { order_id: "failed-first" },
			});
			await archiver.flush();
			const failed = archiver.getHealthSnapshot();
			expect(failed.healthy).toBe(false);
			expect(failed.queue_depth).toBe(1);
			expect(failed.shed_total).toBe(0);
			expect(typeof failed.last_failure_at).toBe("number");
			expect(failed.last_success_at).toBeNull();
			const healthCalls = () =>
				metrics.calls.filter(
					({ kind, name }) =>
						kind === "observable_gauge" && name === "cex_archive_health",
				);
			const failureMetricOffset = metrics.calls.length;
			expect(healthCalls().some(({ value }) => value === 0)).toBe(true);
			status = 200;
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { order_id: "successful-recovery" },
			});
			const beforeSuccessHealthCalls = metrics.calls
				.slice(failureMetricOffset)
				.filter(
					({ kind, name }) =>
						kind === "observable_gauge" && name === "cex_archive_health",
				);
			expect(beforeSuccessHealthCalls).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ value: 1 })]),
			);
			await archiver.flush();
			const recovered = archiver.getHealthSnapshot();
			expect(recovered.healthy).toBe(true);
			expect(recovered.queue_depth).toBe(0);
			expect(recovered.shed_total).toBe(0);
			expect(typeof recovered.last_success_at).toBe("number");
			expect(recovered.sink_errors_total).toBe(1);
			expect(recovered.sink_latency_ms).toBeGreaterThanOrEqual(0);
			expect(healthCalls().at(-1)?.value).toBe(1);
			for (const call of healthCalls()) {
				expect(call.labels).toEqual({ source: "broker_write" });
			}

			const metricNames = new Set(metrics.calls.map(({ name }) => name));
			for (const name of [
				"cex_archive_health",
				"cex_archive_queue_depth",
				"cex_archive_oldest_pending_age_ms",
				"cex_archive_shed_total",
				"cex_archive_last_failure_at",
				"cex_archive_last_shed_at",
				"cex_archive_last_success_at",
				"cex_archive_sink_latency_ms",
				"cex_archive_sink_errors_total",
				"cex_archive_in_flight",
				"cex_archive_in_flight_age_ms",
			]) {
				expect(metricNames.has(name)).toBe(true);
			}
		} finally {
			await archiver.close();
			await server.close();
		}
	});

	test("keeps wall timestamps truthful while event order drives recovery", async () => {
		const wallClockMs = 1_700_000_000_000;
		const originalDateNow = Date.now;
		Date.now = () => wallClockMs;
		let status = 503;
		const server = await startForwarderServer(() => ({ status }));
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: server.url,
			deadLetterPath: createDeadLetterPath(),
			batchSize: 10,
			maxQueueSize: 2,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 100,
		});

		try {
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { order_id: "same-ms-failure" },
			});
			await archiver.flush();
			const failed = archiver.getHealthSnapshot();
			expect(failed.healthy).toBe(false);
			expect(failed.last_failure_at).toBe(wallClockMs);
			expect(failed.last_success_at).toBeNull();
			expect(failed.shed_total).toBe(0);

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { order_id: "same-ms-retained" },
			});
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { order_id: "same-ms-shed" },
			});
			const shed = archiver.getHealthSnapshot();
			expect(shed.healthy).toBe(false);
			expect(shed.last_shed_at).toBe(wallClockMs);
			expect(shed.shed_total).toBe(1);

			status = 200;
			await archiver.flush();
			const recovered = archiver.getHealthSnapshot();
			expect(recovered.healthy).toBe(true);
			expect(recovered.last_failure_at).toBe(wallClockMs);
			expect(recovered.last_shed_at).toBe(wallClockMs);
			expect(recovered.last_success_at).toBe(wallClockMs);
			expect(recovered.shed_total).toBe(1);
			expect(recovered.sink_errors_total).toBe(1);
		} finally {
			Date.now = originalDateNow;
			await archiver.close();
			await server.close();
		}
	});

	test("marks saturation unhealthy before the next enqueue would shed and keeps in-flight age visible", async () => {
		let releaseResponse: () => void = () => {};
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const server = await startForwarderServer(async () => {
			await responseGate;
			return { status: 200 };
		});
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: server.url,
			deadLetterPath: createDeadLetterPath(),
			batchSize: 3,
			maxQueueSize: 2,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 200,
		});

		try {
			for (const orderId of ["saturated-1", "saturated-2"]) {
				archiver.enqueue({
					table: "broker_execution.order_events",
					row: { order_id: orderId },
				});
			}
			const saturated = archiver.getHealthSnapshot();
			expect(saturated.healthy).toBe(false);
			expect(saturated.queue_depth).toBe(2);
			expect(saturated.shed_total).toBe(0);

			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { order_id: "saturated-3" },
			});
			const shed = archiver.getHealthSnapshot();
			expect(shed.healthy).toBe(false);
			expect(shed.shed_total).toBe(1);
			expect(typeof shed.last_shed_at).toBe("number");

			const flushPromise = archiver.flush();
			await waitForCondition(() => server.requests.length === 1);
			await delay(20);
			const inFlight = archiver.getHealthSnapshot();
			expect(inFlight.queue_depth).toBe(0);
			expect(inFlight.in_flight).toBe(true);
			expect(inFlight.in_flight_age_ms).toBeGreaterThan(0);
			expect(inFlight.oldest_pending_age_ms).toBeGreaterThan(0);
			expect(inFlight.oldest_pending_age_ms).toBeGreaterThanOrEqual(
				inFlight.in_flight_age_ms,
			);
			expect(inFlight.healthy).toBe(false);

			releaseResponse();
			await flushPromise;
			const recovered = archiver.getHealthSnapshot();
			expect(recovered.healthy).toBe(true);
			expect(recovered.oldest_pending_age_ms).toBe(0);
			expect(recovered.shed_total).toBe(1);
			expect(recovered.last_shed_at).toBe(shed.last_shed_at);
		} finally {
			await archiver.close();
			await server.close();
		}
	});

	test("keeps a slow successful sink healthy and bounded while the queue refills", async () => {
		let requestCount = 0;
		let releaseFirstResponse: () => void = () => {};
		const firstResponseGate = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const server = await startForwarderServer(async () => {
			requestCount += 1;
			if (requestCount === 1) {
				await firstResponseGate;
			}
			return { status: 200 };
		});
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: server.url,
			deadLetterPath: createDeadLetterPath(),
			batchSize: 10,
			maxQueueSize: 3,
			flushIntervalMs: 60_000,
			forwarderTimeoutMs: 200,
		});

		try {
			for (const orderId of ["slow-1", "slow-2"]) {
				archiver.enqueue({
					table: "broker_execution.order_events",
					row: { order_id: orderId },
				});
			}
			const firstFlush = archiver.flush();
			await waitForCondition(() => server.requests.length === 1);
			await delay(20);
			for (const orderId of ["refill-1", "refill-2"]) {
				archiver.enqueue({
					table: "broker_execution.order_events",
					row: { order_id: orderId },
				});
			}
			expect(archiver.getQueueDepth()).toBe(2);
			expect(archiver.getStats().shed).toBe(0);

			await delay(20);
			releaseFirstResponse();
			await firstFlush;
			expect(archiver.getQueueDepth()).toBe(2);
			expect(archiver.getStats().shed).toBe(0);
			expect(archiver.getHealthSnapshot().healthy).toBe(true);
			expect(archiver.getHealthSnapshot().sink_latency_ms).toBeGreaterThan(0);

			const secondFlush = archiver.flush();
			expect(secondFlush).not.toBe(firstFlush);
			await secondFlush;
			expect(archiver.getQueueDepth()).toBe(0);
			expect(archiver.getStats().shed).toBe(0);
			expect(archiver.getHealthSnapshot().healthy).toBe(true);
			expect(server.requests).toHaveLength(2);
		} finally {
			await archiver.close();
			await server.close();
		}
	});

	test("canPersistMarketMetadataSnapshot is true with an enabled forwarder", async () => {
		const forwarderOnly = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			deadLetterPath: createDeadLetterPath(),
			deploymentId: "test-deploy",
			flushIntervalMs: 60_000,
		});
		expect(forwarderOnly.canPersistMarketMetadataSnapshot()).toBe(true);

		const disabled = BrokerExecutionArchiver.disabled();
		expect(disabled.canPersistMarketMetadataSnapshot()).toBe(false);
		await forwarderOnly.close();
	});

	test("advertises durable account balance snapshots for an enabled archive", async () => {
		const forwarderOnly = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			deadLetterPath: createDeadLetterPath(),
			flushIntervalMs: 60_000,
		});
		const disabled = BrokerExecutionArchiver.disabled();

		expect(forwarderOnly.canPersistAccountBalanceSnapshots()).toBe(true);
		expect(disabled.canPersistAccountBalanceSnapshots()).toBe(false);

		await forwarderOnly.close();
	});
});

describe("broker execution archiver env", () => {
	test("uses closed archive source configuration with broker_write compatibility default", () => {
		expect(resolveArchiveSourceFromEnv(undefined)).toBe("broker_write");
		expect(resolveArchiveSourceFromEnv("broker_read")).toBe("broker_read");
		expect(() => resolveArchiveSourceFromEnv("request_inferred")).toThrow(
			"broker_read or broker_write",
		);
	});
	test("only the exact true enable flag enables archive construction", async () => {
		const originalEnabled = process.env.CEX_BROKER_ARCHIVE_ENABLED;
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalDeadLetterPath =
			process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		delete process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH;

		try {
			for (const enabled of [undefined, "false", "TRUE"]) {
				if (enabled === undefined) {
					delete process.env.CEX_BROKER_ARCHIVE_ENABLED;
				} else {
					process.env.CEX_BROKER_ARCHIVE_ENABLED = enabled;
				}
				const archiver = createBrokerExecutionArchiverFromEnv();
				expect(archiver.isEnabled()).toBe(false);
				await archiver.close();
			}
		} finally {
			restoreEnv("CEX_BROKER_ARCHIVE_ENABLED", originalEnabled);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_URL", originalForwarderUrl);
			restoreEnv("CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH", originalDeadLetterPath);
		}
	});

	test("requires the explicit forwarder URL and dead-letter path when enabled", () => {
		const originalEnabled = process.env.CEX_BROKER_ARCHIVE_ENABLED;
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalDeadLetterPath =
			process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH;
		process.env.CEX_BROKER_ARCHIVE_ENABLED = "true";
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		delete process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH;

		try {
			expect(() => createBrokerExecutionArchiverFromEnv()).toThrow(
				"CEX_BROKER_ARCHIVE_FORWARDER_URL is missing",
			);
			process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL =
				"http://127.0.0.1:8090/archive";
			expect(() => createBrokerExecutionArchiverFromEnv()).toThrow(
				"CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH is missing",
			);
			process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL = "file:///tmp/archive";
			process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH = createDeadLetterPath();
			expect(() => createBrokerExecutionArchiverFromEnv()).toThrow(
				"must use http or https",
			);
			process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL =
				"http://127.0.0.1:8090/archive";
			process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH = archiveTestDirectory;
			let openError: unknown;
			try {
				createBrokerExecutionArchiverFromEnv();
			} catch (error) {
				openError = error;
			}
			expect(openError).toBeInstanceOf(Error);
			expect((openError as Error).message).toContain(
				"CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH",
			);
			expect((openError as Error).message).not.toContain(archiveTestDirectory);
		} finally {
			restoreEnv("CEX_BROKER_ARCHIVE_ENABLED", originalEnabled);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_URL", originalForwarderUrl);
			restoreEnv("CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH", originalDeadLetterPath);
		}
	});

	test("posts to the explicit forwarder and mirrors to OTel only when requested", async () => {
		const server = await startForwarderServer();
		const originalEnabled = process.env.CEX_BROKER_ARCHIVE_ENABLED;
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalDeadLetterPath =
			process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH;
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;
		process.env.CEX_BROKER_ARCHIVE_ENABLED = "true";
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL = server.url;
		process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH = createDeadLetterPath();
		process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED = "true";

		try {
			expect(resolveArchiveForwarderUrlFromEnv()).toBe(server.url);
			expect(isArchiveOtelLogsEnabled()).toBe(true);

			const otelLogs = new MockOtelLogs();
			const archiver = createBrokerExecutionArchiverFromEnv(otelLogs);
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});
			await archiver.flush();
			expect(otelLogs.emits).toHaveLength(1);
			expect(server.requests).toHaveLength(1);
			await archiver.close();
		} finally {
			await server.close();
			restoreEnv("CEX_BROKER_ARCHIVE_ENABLED", originalEnabled);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_URL", originalForwarderUrl);
			restoreEnv("CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH", originalDeadLetterPath);
			restoreEnv(
				"CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED",
				originalOtelLogsEnabled,
			);
		}
	});

	test("disabled and enabled construction each announce startup state once", async () => {
		const info = spyOn(log, "info").mockImplementation(() => {});
		const forwarderUrl = "http://archive.example.invalid/private/archive";
		const deadLetterPath = createDeadLetterPath();
		try {
			const disabled = BrokerExecutionArchiver.disabled();
			const enabled = BrokerExecutionArchiver.create({
				forwarderUrl,
				deadLetterPath,
				otelLogs: new MockOtelLogs(),
				deploymentId: "announce-test",
				flushIntervalMs: 60_000,
			});
			expect(
				info.mock.calls.filter(
					([message]) => message === "Broker execution archive disabled",
				),
			).toHaveLength(1);
			expect(
				info.mock.calls.filter(
					([message]) => message === "Broker execution archive enabled",
				),
			).toHaveLength(1);
			const enabledCall = info.mock.calls.find(
				([message]) => message === "Broker execution archive enabled",
			);
			expect(enabledCall?.[1]).toEqual({
				enabled: true,
				source: "broker_write",
				otel_mirror_enabled: true,
			});
			const startupOutput = JSON.stringify(enabledCall);
			expect(startupOutput).not.toContain(forwarderUrl);
			expect(startupOutput).not.toContain(deadLetterPath);
			expect(startupOutput).not.toContain("announce-test");
			await disabled.close();
			await enabled.close();
		} finally {
			info.mockRestore();
		}
	});
});

describe("deposit observation archive", () => {
	test("records the venue credit time when the venue reports it as an epoch integer", async () => {
		const forwarder = await startForwarderServer();
		const archiver = BrokerExecutionArchiver.create({
			forwarderUrl: forwarder.url,
			deadLetterPath: createDeadLetterPath(),
			deploymentId: "test-deploy",
			batchSize: 100,
			flushIntervalMs: 60_000,
		});
		// Binance reports insertTime as an integer, which ccxt surfaces as
		// `timestamp`; `datetime` is absent from this shape on purpose.
		const insertTime = 1_784_000_000_123;
		const broker = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [
				{
					txid: "0xdeposited",
					currency: "USDC",
					amount: 10,
					address: "0xrecipient",
					status: "ok",
					timestamp: insertTime,
					info: { status: "1", insertTime },
				},
			],
		} as unknown as Exchange;

		const context = {
			call: {
				request: {
					payload: {
						recipientAddress: "0xrecipient",
						amount: "10",
						transactionHash: "0xdeposited",
					},
				},
			},
			wrappedCallback: () => {},
			policy: { deposit: {} },
			brokers: {},
			metadata: {},
			normalizedCex: "binance",
			cex: "binance",
			symbol: "USDC",
			selectedBrokerAccount: { exchange: broker, label: "primary" },
			broker,
			verity: { proof: "" },
			applyVerityToBroker: () => {},
			useVerity: false,
			verityProverUrl: "",
			brokerArchiver: archiver,
		} as unknown as ExecuteActionContext;

		try {
			await handleDeposit(context);
			await Promise.resolve();
			await archiver.flush();

			const rows = forwarder.requests.flatMap(
				(request) => request.body.rows ?? [],
			) as Array<{ row: Record<string, unknown> }>;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.row).toMatchObject({
				event_kind: "deposit",
				lifecycle_action: "observe_deposit",
				external_id: "0xdeposited",
				exchange_timestamp: new Date(insertTime).toISOString(),
			});
		} finally {
			await archiver.close();
			await forwarder.close();
		}
	});
});
