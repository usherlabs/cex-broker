import { describe, expect, test } from "bun:test";
import type { LogRecord } from "@opentelemetry/api-logs";
import { MAX_ARCHIVE_BODY_BYTES } from "../services/archive-forwarder/limits";
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
	normalizeCcxtBalanceForArchive,
	normalizeCcxtTradeForArchive,
	normalizeCcxtTransactionForArchive,
} from "../src/helpers/broker-execution-archive/rows";
import {
	DEFAULT_WITHDRAWAL_OBSERVATION_TRACKER_MAX_ENTRIES,
	WithdrawalObservationTracker,
} from "../src/helpers/broker-execution-archive/withdrawal-observation-tracker";
import {
	BrokerExecutionArchiver,
	createBrokerExecutionArchiverFromEnv,
	isArchiveOtelLogsEnabled,
	isBrokerExecutionArchiveTable,
	resolveArchiveForwarderUrlFromEnv,
} from "../src/helpers/broker-execution-archive/writer";
import { buildOrderExecutionTelemetry } from "../src/helpers/order-telemetry";
import type { OtelLogs } from "../src/helpers/otel";
import { startForwarderServer } from "./archive-forwarder-server";

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = original;
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

	test("builds order event rows tagged for broker_execution.order_events", () => {
		const telemetry = buildOrderExecutionTelemetry(
			{
				action: "CancelOrder",
				cex: "binance",
				accountLabel: "primary",
				symbol: "ARB/USDT",
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

	test("posts JSON with the bearer token over the real node:http transport", async () => {
		const server = await startForwarderServer();
		const originalToken = process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN;
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_TOKEN = "secret-token";

		try {
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
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
				source: "broker_write",
				deployment_id: "test-deploy",
			});

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

	test("enqueue is non-blocking and sheds oldest rows when queue is full", async () => {
		const server = await startForwarderServer();
		try {
			const otelLogs = new MockOtelLogs();
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
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
			// ...but the forwarder is the durable sink for both tables.
			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.body).toMatchObject({
				rows: expect.arrayContaining([
					expect.objectContaining({ table: "broker_execution.order_events" }),
					expect.objectContaining({ table: "market_data.orderbook_snapshots" }),
					expect.objectContaining({
						table: "broker_account.balance_snapshots",
					}),
				]),
			});

			await archiver.close();
		} finally {
			await server.close();
		}
	});

	test("drops market-data and account-balance rows when the forwarder is missing", async () => {
		const otelLogs = new MockOtelLogs();
		const archiver = BrokerExecutionArchiver.create({
			otelLogs,
			deploymentId: "test-deploy",
			batchSize: 10,
			flushIntervalMs: 60_000,
		});

		archiver.enqueue({
			table: "market_data.candles",
			row: { source: "broker_write", open_time_ms: 1_000 },
		});
		archiver.enqueue({
			table: "broker_account.balance_snapshots",
			row: { source: "broker_write", reported_assets: ["USDC"] },
		});
		archiver.enqueue({
			table: "broker_execution.order_events",
			row: { source: "broker_write", order_id: "1" },
		});

		expect(archiver.getQueueDepth()).toBe(1);

		await archiver.flush();
		expect(otelLogs.emits).toHaveLength(1);
		expect(otelLogs.emits[0]?.body).toBe("broker_execution.order_events");

		await archiver.close();
	});

	test("close exits after forwarder failure instead of retrying forever", async () => {
		const server = await startForwarderServer(() => ({ status: 503 }));
		try {
			const archiver = BrokerExecutionArchiver.create({
				forwarderUrl: server.url,
				deploymentId: "test-deploy",
				batchSize: 10,
				flushIntervalMs: 60_000,
			});

			archiver.enqueue({
				table: "market_data.candles",
				row: { source: "broker_write", open_time_ms: 1_000 },
			});

			await expect(archiver.close()).resolves.toBeUndefined();
			expect(archiver.getQueueDepth()).toBe(0);
			expect(archiver.getStats().forwarderFailures).toBeGreaterThan(0);
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

	test("canPersistMarketMetadataSnapshot is true with a forwarder-only config", () => {
		const forwarderOnly = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			deploymentId: "test-deploy",
			flushIntervalMs: 60_000,
		});
		expect(forwarderOnly.canPersistMarketMetadataSnapshot()).toBe(true);

		const disabled = BrokerExecutionArchiver.disabled();
		expect(disabled.canPersistMarketMetadataSnapshot()).toBe(false);
	});

	test("advertises durable account balance snapshots only when an HTTP forwarder exists", async () => {
		const forwarderOnly = BrokerExecutionArchiver.create({
			forwarderUrl: "http://127.0.0.1:9/archive",
			flushIntervalMs: 60_000,
		});
		const otelOnly = BrokerExecutionArchiver.create({
			otelLogs: new MockOtelLogs(),
			flushIntervalMs: 60_000,
		});
		const disabled = BrokerExecutionArchiver.disabled();

		expect(forwarderOnly.canPersistAccountBalanceSnapshots()).toBe(true);
		expect(otelOnly.isEnabled()).toBe(true);
		expect(otelOnly.canPersistAccountBalanceSnapshots()).toBe(false);
		expect(disabled.canPersistAccountBalanceSnapshots()).toBe(false);

		await forwarderOnly.close();
		await otelOnly.close();
	});
});

describe("broker execution archiver env", () => {
	test("resolveArchiveForwarderUrlFromEnv derives the ClickHouse forwarder URL with defaults", () => {
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalForwarderHost = process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		const originalForwarderPort = process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT;
		const originalClickhouseHost = process.env.CEX_BROKER_CLICKHOUSE_HOST;
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT;
		process.env.CEX_BROKER_CLICKHOUSE_HOST = "clickhouse.local";
		delete process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		try {
			expect(resolveArchiveForwarderUrlFromEnv()).toBe(
				"http://clickhouse.local:8090/archive",
			);
			expect(isArchiveOtelLogsEnabled()).toBe(false);
		} finally {
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_URL", originalForwarderUrl);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_HOST", originalForwarderHost);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_PORT", originalForwarderPort);
			restoreEnv("CEX_BROKER_CLICKHOUSE_HOST", originalClickhouseHost);
			restoreEnv(
				"CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED",
				originalOtelLogsEnabled,
			);
		}
	});

	test("createBrokerExecutionArchiverFromEnv posts to the derived forwarder without OTel logs", async () => {
		const server = await startForwarderServer();
		const port = new URL(server.url).port;
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalForwarderHost = process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		const originalForwarderPort = process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT;
		const originalClickhouseHost = process.env.CEX_BROKER_CLICKHOUSE_HOST;
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		// Point the ClickHouse-host resolution path at the local forwarder so the
		// row actually travels the production node:http transport.
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		process.env.CEX_BROKER_CLICKHOUSE_HOST = "127.0.0.1";
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_PORT = port;
		delete process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;

		try {
			expect(resolveArchiveForwarderUrlFromEnv()).toBe(server.url);
			expect(isArchiveOtelLogsEnabled()).toBe(false);

			const otelLogs = new MockOtelLogs();
			const archiver = createBrokerExecutionArchiverFromEnv(otelLogs);
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});
			await archiver.flush();
			// No OTel mirror (flag off), but the row still lands at the forwarder.
			expect(otelLogs.emits).toHaveLength(0);
			expect(server.requests).toHaveLength(1);
			await archiver.close();
		} finally {
			await server.close();
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_URL", originalForwarderUrl);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_HOST", originalForwarderHost);
			restoreEnv("CEX_BROKER_ARCHIVE_FORWARDER_PORT", originalForwarderPort);
			restoreEnv("CEX_BROKER_CLICKHOUSE_HOST", originalClickhouseHost);
			restoreEnv(
				"CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED",
				originalOtelLogsEnabled,
			);
		}
	});

	test("createBrokerExecutionArchiverFromEnv mirrors to OTel logs only when enabled", async () => {
		const originalOtelLogsEnabled =
			process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;
		const originalForwarderUrl = process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		const originalForwarderHost = process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		const originalClickhouseHost = process.env.CEX_BROKER_CLICKHOUSE_HOST;
		process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED = "true";
		// Isolate the OTel mirror: no forwarder configured so flush has a single sink.
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
		delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
		delete process.env.CEX_BROKER_CLICKHOUSE_HOST;

		try {
			const otelLogs = new MockOtelLogs();
			const archiver = createBrokerExecutionArchiverFromEnv(otelLogs);
			archiver.enqueue({
				table: "broker_execution.order_events",
				row: { source: "broker_write", order_id: "1" },
			});
			await archiver.flush();
			expect(otelLogs.emits).toHaveLength(1);
			await archiver.close();
		} finally {
			if (originalOtelLogsEnabled === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED;
			} else {
				process.env.CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED =
					originalOtelLogsEnabled;
			}
			if (originalForwarderUrl === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL;
			} else {
				process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL = originalForwarderUrl;
			}
			if (originalForwarderHost === undefined) {
				delete process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST;
			} else {
				process.env.CEX_BROKER_ARCHIVE_FORWARDER_HOST = originalForwarderHost;
			}
			if (originalClickhouseHost === undefined) {
				delete process.env.CEX_BROKER_CLICKHOUSE_HOST;
			} else {
				process.env.CEX_BROKER_CLICKHOUSE_HOST = originalClickhouseHost;
			}
		}
	});
});
