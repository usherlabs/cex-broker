import { describe, expect, spyOn, test } from "bun:test";
import type { BrokerAccount, BrokerPoolEntry } from "../src/helpers/broker";
import type {
	BrokerArchiveRow,
	BrokerExecutionArchiver,
} from "../src/helpers/broker-execution-archive";
import {
	DepositArchivePoller,
	nextDepositCursor,
	parseBinanceUnlockProgress,
} from "../src/helpers/deposit-archive-poller";

import { log } from "../src/helpers/logger";
import type {
	DepositPollObservation,
	StreamHealthPublisher,
	StreamHealthSnapshot,
} from "../src/helpers/stream-health-publisher";

// Records every publication in order; the real publisher is exercised by its
// own tests, this one only needs the snapshots the poller hands it.
function fakeCoveragePublisher(published: StreamHealthSnapshot[][]) {
	const publisher = {
		start: () => {},
		publish: (snapshots: readonly StreamHealthSnapshot[]) => {
			published.push(snapshots.map((snapshot) => ({ ...snapshot })));
		},
		close: async (snapshots: readonly StreamHealthSnapshot[]) => {
			published.push(snapshots.map((snapshot) => ({ ...snapshot })));
		},
	};
	return publisher as unknown as StreamHealthPublisher;
}

function lastObservation(
	published: StreamHealthSnapshot[][],
	accountSelector = "primary",
): { snapshot: StreamHealthSnapshot; observation: DepositPollObservation } {
	const batch = published.at(-1);
	const snapshot = batch?.find(
		(entry) => entry.accountSelector === accountSelector,
	);
	if (!snapshot || snapshot.streamKind !== "deposit_poller") {
		throw new Error(
			`Expected a deposit_poller snapshot for ${accountSelector}`,
		);
	}
	return { snapshot, observation: snapshot.pollObservation };
}

function account(
	exchange: unknown,
	label: BrokerAccount["label"] = "primary",
	index?: number,
): BrokerAccount {
	return { exchange, label, index } as unknown as BrokerAccount;
}

function poolWith(exchange: unknown): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: account(exchange),
			secondaryBrokers: [],
		},
	};
}

type RecordedCounter = {
	name: string;
	value: number;
	labels: Record<string, string | number>;
};

function fakeMetrics(sink: RecordedCounter[]) {
	return {
		recordCounter: async (
			name: string,
			value: number,
			labels: Record<string, string | number>,
		) => {
			sink.push({ name, value, labels });
		},
	} as unknown as ConstructorParameters<
		typeof DepositArchivePoller
	>[0]["metrics"];
}

function fakeArchiver(sink: BrokerArchiveRow[]): BrokerExecutionArchiver {
	return {
		isEnabled: () => true,
		getDeploymentId: () => "deploy-a",
		enqueue: (row: BrokerArchiveRow) => sink.push(row),
	} as unknown as BrokerExecutionArchiver;
}

describe("nextDepositCursor", () => {
	test("stops at the oldest pending deposit while advancing past older terminal deposits", () => {
		expect(
			nextDepositCursor(
				[
					{ timestamp: 100, status: "ok" },
					{ timestamp: 300, status: "complete" },
					{ timestamp: 200, status: "processing" },
				],
				0,
				50,
			),
		).toBe(200);
	});

	test("holds the watermark for a full batch under either venue ordering", () => {
		const oldestFirst = [
			{ timestamp: 100, status: "ok" },
			{ timestamp: 200, status: "ok" },
		];
		const newestFirst = [...oldestFirst].reverse();

		expect(nextDepositCursor(oldestFirst, 50, 2)).toBe(50);
		expect(nextDepositCursor(newestFirst, 50, 2)).toBe(50);
	});

	test("uses native rejected and wrong-deposit statuses for cursor advancement", () => {
		expect(
			nextDepositCursor(
				[
					{ timestamp: 100, status: "pending", info: { status: 2 } },
					{ timestamp: 200, status: "pending", info: { status: 7 } },
				],
				0,
				50,
				"binance",
			),
		).toBe(201);
	});

	test("advances an unlocked native status 1 without a normalized status", () => {
		expect(
			nextDepositCursor(
				[
					{
						timestamp: 300,
						info: {
							status: 1,
							confirmTimes: "2/1",
							unlockConfirm: 2,
						},
					},
				],
				0,
				50,
				"binance",
			),
		).toBe(301);
	});
});

describe("parseBinanceUnlockProgress", () => {
	test("parses native confirmation progress and records its source", () => {
		const progress = parseBinanceUnlockProgress({
			info: {
				status: "1",
				confirmTimes: "1/15",
				unlockConfirm: 2,
				completeTime: 1_784_000_000_123,
			},
		});

		expect(progress).toMatchObject({
			version: 1,
			state: "credited_not_withdrawable",
			progress_state: "valid",
			reason: null,
			native_status: 1,
			current: 1,
			credit_required: 15,
			unlock_required: 2,
			complete_time: 1_784_000_000_123,
			source: {
				venue: "binance",
				endpoint: "GET /sapi/v1/capital/deposit/hisrec",
				fields: {
					status: "info.status",
					confirmTimes: "info.confirmTimes",
					unlockConfirm: "info.unlockConfirm",
					completeTime: "info.completeTime",
				},
			},
		});
		expect(progress.observed_at).toEqual(expect.any(String));
	});

	test("fails closed on missing or malformed unlock fields", () => {
		expect(
			parseBinanceUnlockProgress({
				info: { status: "1", confirmTimes: "not-a-fraction", unlockConfirm: 2 },
			}),
		).toMatchObject({
			state: "unknown",
			progress_state: "unknown",
			current: null,
			credit_required: null,
			unlock_required: 2,
		});

		expect(
			parseBinanceUnlockProgress({
				info: {
					status: "1",
					confirmTimes: "1/1",
					unlockConfirm: -1,
				},
			}),
		).toMatchObject({
			state: "unknown",
			progress_state: "unknown",
			current: 1,
			credit_required: 1,
			unlock_required: null,
		});

		expect(parseBinanceUnlockProgress({ info: { status: 1 } })).toMatchObject({
			state: "unknown",
			progress_state: "unknown",
			native_status: 1,
			current: null,
			credit_required: null,
			unlock_required: null,
		});
	});
});

describe("DepositArchivePoller.pollAllOnce", () => {
	test("archives deposits with the transfer-event row shape", async () => {
		const rawDeposit = {
			id: "deposit-1",
			txid: "0xdeposit",
			currency: "USDC",
			amount: "25.500000",
			address: "0xrecipient",
			network: "ARBITRUM",
			timestamp: 1_775_000_000_000,
			creditedAt: "2026-04-01T12:00:00.000Z",
			info: {
				status: "1",
				confirmTimes: "1/1",
				unlockConfirm: 1,
				venueField: "preserved",
			},
		};
		const calls: unknown[][] = [];
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (...args: unknown[]) => {
				calls.push(args);
				return [rawDeposit];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		expect(await poller.pollAllOnce()).toBe(true);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBeUndefined();
		expect(calls[0]?.[2]).toBe(50);
		expect(sink).toHaveLength(1);
		expect(sink[0]?.table).toBe("broker_execution.transfer_events");
		expect(sink[0]?.row).toMatchObject({
			source: "broker_write",
			deployment_id: "deploy-a",
			exchange: "binance",
			account_selector: "primary",
			symbol: "USDC",
			asset_symbol: "USDC",
			schema_version: "1",
			event_kind: "deposit",
			lifecycle_action: "observe_deposit",
			status: "ok",
			amount: "25.500000",
			address: "0xrecipient",
			network: "ARBITRUM",
			external_id: "0xdeposit",
			client_withdrawal_id: "",
			txid: "0xdeposit",
			result_index: 0,
			exchange_timestamp: "2026-04-01T12:00:00.000Z",
		});
		const payload = JSON.parse(String(sink[0]?.row.payload_json)) as Record<
			string,
			unknown
		>;
		expect(payload).toMatchObject({
			...rawDeposit,
			unlock_progress: {
				version: 1,
				state: "ok",
				progress_state: "valid",
				native_status: 1,
				current: 1,
				credit_required: 1,
				unlock_required: 1,
				complete_time: null,
				source: {
					venue: "binance",
					endpoint: "GET /sapi/v1/capital/deposit/hisrec",
					fields: {
						status: "info.status",
						confirmTimes: "info.confirmTimes",
						unlockConfirm: "info.unlockConfirm",
						completeTime: "info.completeTime",
					},
				},
			},
		});
	});

	test("records the venue credit time when the venue reports it as an epoch integer", async () => {
		// Binance reports insertTime as an integer, which ccxt surfaces as
		// `timestamp`; `datetime` is absent from this shape on purpose.
		const insertTime = 1_784_000_000_123;
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [
				{
					txid: "0xinteger-credit",
					currency: "USDC",
					amount: "12",
					status: "ok",
					timestamp: insertTime,
					info: {
						status: "1",
						confirmTimes: "1/1",
						unlockConfirm: 1,
						insertTime,
					},
				},
			],
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();

		expect(sink).toHaveLength(1);
		expect(sink[0]?.row).toMatchObject({
			external_id: "0xinteger-credit",
			exchange_timestamp: new Date(insertTime).toISOString(),
		});
	});

	test("advances the account cursor and does not re-archive within a session", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const deposit = {
			txid: "0xonce",
			currency: "USDT",
			amount: 10,
			status: "ok",
			timestamp: depositTimestamp,
			info: {
				status: "1",
				confirmTimes: "1/1",
				unlockConfirm: 1,
			},
		};
		const sinceValues: Array<number | undefined> = [];
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (code?: string, since?: number, limit?: number) => {
				expect(code).toBeUndefined();
				expect(limit).toBe(50);
				sinceValues.push(since);
				return since !== undefined && since <= depositTimestamp
					? [deposit]
					: [];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sinceValues).toHaveLength(2);
		expect(sinceValues[1]).toBe(depositTimestamp + 1);
		expect(sink).toHaveLength(1);
		expect(sink[0]?.row).toMatchObject({
			symbol: "USDT",
			external_id: "0xonce",
		});
	});

	test("re-observes a pending deposit until its normalized status is terminal", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const sinceValues: Array<number | undefined> = [];
		let calls = 0;
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (code?: string, since?: number, limit?: number) => {
				expect(code).toBeUndefined();
				expect(limit).toBe(50);
				sinceValues.push(since);
				calls += 1;
				return [
					{
						txid: "0xtransition",
						currency: "USDC",
						amount: 15,
						status: calls === 1 ? "pending" : "ok",
						timestamp: depositTimestamp,
						info:
							calls === 1
								? { status: "0" }
								: {
										status: "1",
										confirmTimes: "1/1",
										unlockConfirm: 1,
									},
					},
				];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sinceValues).toHaveLength(2);
		expect(sinceValues[1]).toBe(depositTimestamp);
		expect(sink).toHaveLength(2);
		expect(sink.map(({ row }) => row.status)).toEqual(["pending", "ok"]);
		expect(sink[1]?.row).toMatchObject({
			lifecycle_action: "observe_deposit",
			external_id: "0xtransition",
			status: "ok",
		});
	});

	test("archives Binance locked and unlocked deposit states as distinct rows", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const sinceValues: Array<number | undefined> = [];
		let calls = 0;
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (code?: string, since?: number, limit?: number) => {
				expect(code).toBeUndefined();
				expect(limit).toBe(50);
				sinceValues.push(since);
				calls += 1;
				return since !== undefined && since <= depositTimestamp
					? [
							{
								txid: "0xlocked",
								currency: "ARB",
								amount: 25,
								status: "ok",
								timestamp: depositTimestamp,
								info:
									calls === 1
										? {
												status: "6",
												confirmTimes: "1/1",
												unlockConfirm: 2,
											}
										: {
												status: "1",
												confirmTimes: "2/1",
												unlockConfirm: 2,
											},
							},
						]
					: [];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sinceValues).toHaveLength(2);
		expect(sinceValues[1]).toBe(depositTimestamp);
		expect(sink.map(({ row }) => row.status)).toEqual([
			"credited_not_withdrawable",
			"ok",
		]);
		expect(sink[0]?.row).toMatchObject({
			external_id: "0xlocked",
			status: "credited_not_withdrawable",
		});

		await poller.pollAllOnce();

		expect(sinceValues[2]).toBe(depositTimestamp + 1);
		expect(sink).toHaveLength(2);
	});

	test("does not re-archive an unchanged Binance locked deposit", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const sinceValues: Array<number | undefined> = [];
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (code?: string, since?: number, limit?: number) => {
				expect(code).toBeUndefined();
				expect(limit).toBe(50);
				sinceValues.push(since);
				return [
					{
						txid: "0xstill-locked",
						currency: "ARB",
						amount: 25,
						status: "ok",
						timestamp: depositTimestamp,
						info: {
							status: 6,
							confirmTimes: "1/2",
							unlockConfirm: 2,
						},
					},
				];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sinceValues[1]).toBe(depositTimestamp);
		expect(sink).toHaveLength(1);
		expect(sink[0]?.row.status).toBe("credited_not_withdrawable");
	});

	test("re-polls status 1 below unlock threshold before archiving completion", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const sinceValues: Array<number | undefined> = [];
		let calls = 0;
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (code?: string, since?: number, limit?: number) => {
				expect(code).toBeUndefined();
				expect(limit).toBe(50);
				sinceValues.push(since);
				calls += 1;
				return since !== undefined && since <= depositTimestamp
					? [
							{
								txid: "0xstatus-one",
								currency: "ARB",
								amount: 25,
								status: "ok",
								timestamp: depositTimestamp,
								info: {
									status: 1,
									confirmTimes: calls === 1 ? "1/1" : "2/1",
									unlockConfirm: 2,
								},
							},
						]
					: [];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sinceValues).toEqual([
			expect.any(Number),
			depositTimestamp,
			depositTimestamp + 1,
		]);
		expect(sink.map(({ row }) => row.status)).toEqual([
			"credited_not_withdrawable",
			"ok",
		]);
		expect(JSON.parse(String(sink[0]?.row.payload_json))).toMatchObject({
			unlock_progress: {
				state: "credited_not_withdrawable",
				native_status: 1,
				current: 1,
				credit_required: 1,
				unlock_required: 2,
			},
		});
		expect(JSON.parse(String(sink[1]?.row.payload_json))).toMatchObject({
			unlock_progress: {
				state: "ok",
				native_status: 1,
				current: 2,
				credit_required: 1,
				unlock_required: 2,
			},
		});
	});

	test("archives confirmation progress changes while Binance status 6 stays locked", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const sinceValues: Array<number | undefined> = [];
		let calls = 0;
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (code?: string, since?: number, limit?: number) => {
				expect(code).toBeUndefined();
				expect(limit).toBe(50);
				sinceValues.push(since);
				calls += 1;
				return since !== undefined && since <= depositTimestamp
					? [
							{
								txid: "0xstatus-six",
								currency: "ARB",
								amount: 25,
								status: "ok",
								timestamp: depositTimestamp,
								info: {
									status: 6,
									confirmTimes: calls === 1 ? "1/2" : "2/2",
									unlockConfirm: 3,
								},
							},
						]
					: [];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sinceValues[1]).toBe(depositTimestamp);
		expect(sinceValues[2]).toBe(depositTimestamp);
		expect(sink).toHaveLength(2);
		expect(sink.map(({ row }) => row.status)).toEqual([
			"credited_not_withdrawable",
			"credited_not_withdrawable",
		]);
		expect(JSON.parse(String(sink[1]?.row.payload_json))).toMatchObject({
			unlock_progress: {
				state: "credited_not_withdrawable",
				current: 2,
				credit_required: 2,
				unlock_required: 3,
			},
		});
	});

	test("archives malformed unlock progress as unknown and keeps polling", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const sinceValues: Array<number | undefined> = [];
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (code?: string, since?: number, limit?: number) => {
				expect(code).toBeUndefined();
				expect(limit).toBe(50);
				sinceValues.push(since);
				return [
					{
						txid: "0xmalformed-progress",
						currency: "ARB",
						amount: 25,
						status: "ok",
						timestamp: depositTimestamp,
						info: {
							status: 1,
							confirmTimes: "not-a-fraction",
							unlockConfirm: 2,
						},
					},
				];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sinceValues[1]).toBe(depositTimestamp);
		expect(sink).toHaveLength(1);
		expect(sink[0]?.row.status).toBe("unknown");
		expect(JSON.parse(String(sink[0]?.row.payload_json))).toMatchObject({
			unlock_progress: {
				state: "unknown",
				progress_state: "unknown",
				current: null,
				credit_required: null,
				unlock_required: 2,
			},
		});
	});

	test("archives confirmation decreases and target changes as contradictory unknown observations", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const sinceValues: Array<number | undefined> = [];
		let calls = 0;
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (code?: string, since?: number, limit?: number) => {
				expect(code).toBeUndefined();
				expect(limit).toBe(50);
				sinceValues.push(since);
				calls += 1;
				const confirmTimes =
					calls === 1
						? "2/2"
						: calls === 2
							? "1/2"
							: calls === 3
								? "2/3"
								: "2/2";
				return [
					{
						txid: "0xcontradiction",
						currency: "ARB",
						amount: 25,
						status: "ok",
						timestamp: depositTimestamp,
						info: {
							status: 6,
							confirmTimes,
							unlockConfirm: calls === 3 ? 3 : 2,
						},
					},
				];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();
		await poller.pollAllOnce();
		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sinceValues.slice(1, 5)).toEqual([
			depositTimestamp,
			depositTimestamp,
			depositTimestamp,
			depositTimestamp,
		]);
		expect(sink.map(({ row }) => row.status)).toEqual([
			"credited_not_withdrawable",
			"unknown",
			"unknown",
			"credited_not_withdrawable",
		]);
		expect(JSON.parse(String(sink[1]?.row.payload_json))).toMatchObject({
			unlock_progress: {
				state: "unknown",
				progress_state: "contradictory",
				reason: "confirmation_progress_regressed_or_requirement_changed",
			},
		});
	});

	test("isolates identical deposit identities across accounts", async () => {
		const depositTimestamp = Date.now() + 10_000;
		const deposit = (status: number) => ({
			txid: "0xaccount-isolation",
			currency: "ARB",
			network: "ARBITRUM",
			amount: 25,
			status: "ok",
			timestamp: depositTimestamp,
			info: {
				status,
				confirmTimes: "1/1",
				unlockConfirm: status === 6 ? 2 : 1,
			},
		});
		const primaryExchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (_code?: string, since?: number) =>
				since !== undefined && since <= depositTimestamp ? [deposit(6)] : [],
		};
		const secondaryExchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async (_code?: string, since?: number) =>
				since !== undefined && since <= depositTimestamp ? [deposit(1)] : [],
		};
		const sink: BrokerArchiveRow[] = [];
		const poller = new DepositArchivePoller({
			brokers: {
				binance: {
					primary: account(primaryExchange, "primary"),
					secondaryBrokers: [account(secondaryExchange, "secondary")],
				},
			},
			archiver: fakeArchiver(sink),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(sink).toHaveLength(2);
		expect(sink.map(({ row }) => row.account_selector)).toEqual([
			"primary",
			"secondary",
		]);
		expect(sink.map(({ row }) => row.status)).toEqual([
			"credited_not_withdrawable",
			"ok",
		]);
	});

	test("logs once and cleanly skips an account without fetchDeposits", async () => {
		const info = spyOn(log, "info").mockImplementation(() => {});
		try {
			const sink: BrokerArchiveRow[] = [];
			const poller = new DepositArchivePoller({
				brokers: poolWith({ has: { fetchDeposits: false } }),
				archiver: fakeArchiver(sink),
			});

			expect(await poller.pollAllOnce()).toBe(true);
			expect(await poller.pollAllOnce()).toBe(true);

			expect(sink).toHaveLength(0);
			expect(info).toHaveBeenCalledTimes(1);
			expect(info).toHaveBeenCalledWith(
				"Deposit archive poll skipped: fetchDeposits unsupported",
				{
					exchange: "binance",
					account: "primary",
				},
			);
		} finally {
			info.mockRestore();
		}
	});

	test("logs a fetch error and archives on the next pass", async () => {
		const warn = spyOn(log, "warn").mockImplementation(() => {});
		try {
			let calls = 0;
			const exchange = {
				has: { fetchDeposits: true },
				fetchDeposits: async () => {
					calls += 1;
					if (calls === 1) {
						throw new Error("rate limited");
					}
					return [
						{
							txid: "0xrecovered",
							currency: "USDC",
							amount: "5",
							timestamp: Date.now() + 10_000,
							info: {
								status: "1",
								confirmTimes: "1/1",
								unlockConfirm: 1,
							},
						},
					];
				},
			};
			const sink: BrokerArchiveRow[] = [];
			const poller = new DepositArchivePoller({
				brokers: poolWith(exchange),
				archiver: fakeArchiver(sink),
			});

			expect(await poller.pollAllOnce()).toBe(true);
			expect(await poller.pollAllOnce()).toBe(true);

			expect(calls).toBe(2);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toBe("Deposit archive poll failed");
			expect(warn.mock.calls[0]?.[1]).toMatchObject({
				exchange: "binance",
				account: "primary",
			});
			expect(sink).toHaveLength(1);
			expect(sink[0]?.row).toMatchObject({
				external_id: "0xrecovered",
				status: "ok",
			});
		} finally {
			warn.mockRestore();
		}
	});
});

describe("DepositArchivePoller liveness signal", () => {
	test("records a heartbeat for a successful poll", async () => {
		const counters: RecordedCounter[] = [];
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [],
		};
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			metrics: fakeMetrics(counters),
		});

		await poller.pollAllOnce();

		expect(counters).toEqual([
			{
				name: "cex_deposit_poller_polls_total",
				value: 1,
				labels: { exchange: "binance", outcome: "ok" },
			},
		]);
	});

	test("records a heartbeat for an account without fetchDeposits", async () => {
		const info = spyOn(log, "info").mockImplementation(() => {});
		try {
			const counters: RecordedCounter[] = [];
			const poller = new DepositArchivePoller({
				brokers: poolWith({ has: { fetchDeposits: false } }),
				archiver: fakeArchiver([]),
				metrics: fakeMetrics(counters),
			});

			await poller.pollAllOnce();

			expect(counters).toEqual([
				{
					name: "cex_deposit_poller_polls_total",
					value: 1,
					labels: { exchange: "binance", outcome: "unsupported" },
				},
			]);
		} finally {
			info.mockRestore();
		}
	});

	test("counts a hung fetchDeposits as a failed poll and polls again", async () => {
		const warn = spyOn(log, "warn").mockImplementation(() => {});
		try {
			let calls = 0;
			const exchange = {
				has: { fetchDeposits: true },
				fetchDeposits: async () => {
					calls += 1;
					if (calls === 1) {
						// Never settles: the silent-death mode the timeout exists for.
						return new Promise<unknown[]>(() => {});
					}
					return [
						{
							txid: "0xafter-hang",
							currency: "USDC",
							amount: "5",
							status: "ok",
							timestamp: Date.now() + 10_000,
						},
					];
				},
			};
			const counters: RecordedCounter[] = [];
			const sink: BrokerArchiveRow[] = [];
			const poller = new DepositArchivePoller({
				brokers: poolWith(exchange),
				archiver: fakeArchiver(sink),
				metrics: fakeMetrics(counters),
				config: { fetchTimeoutMs: 10 },
			});

			expect(await poller.pollAllOnce()).toBe(true);

			expect(warn.mock.calls[0]?.[0]).toBe("Deposit archive poll failed");
			expect(
				String((warn.mock.calls[0]?.[1] as { error: unknown }).error),
			).toContain("fetchDeposits timed out after 10ms");
			expect(counters).toEqual([
				{
					name: "cex_deposit_poller_errors_total",
					value: 1,
					labels: { exchange: "binance" },
				},
				{
					name: "cex_deposit_poller_polls_total",
					value: 1,
					labels: { exchange: "binance", outcome: "error" },
				},
			]);

			expect(await poller.pollAllOnce()).toBe(true);
			expect(sink).toHaveLength(1);
			expect(sink[0]?.row).toMatchObject({ external_id: "0xafter-hang" });
		} finally {
			warn.mockRestore();
		}
	});
});

describe("deposit poll coverage", () => {
	// A deposit inside the default one-day lookback and before the poll
	// attempt: the poller's first since-watermark then precedes it, as the
	// venue contract requires, so the held cursor keeps its dedupe memory.
	const creditedTimestamp = Date.now() - 60_000;
	const credited = {
		txid: "0xcovered",
		currency: "USDT",
		amount: "5",
		network: "ARBITRUM",
		status: "pending",
		timestamp: creditedTimestamp,
		info: { status: "6", confirmTimes: "3/12", unlockConfirm: 12 },
	};

	test("publishes exact coverage on success and keeps publishing it when the business row dedupes", async () => {
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [credited],
		};
		const sink: BrokerArchiveRow[] = [];
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
			coveragePublisher: fakeCoveragePublisher(published),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		// One archived business row, two published observations: the second
		// poll proved the same deposit again without re-archiving it.
		expect(sink).toHaveLength(1);
		expect(published).toHaveLength(2);
		const { snapshot, observation } = lastObservation(published);
		expect(snapshot).toMatchObject({
			exchange: "binance",
			accountSelector: "primary",
			streamKind: "deposit_poller",
			state: "connected",
			lastFailureKind: "none",
			connectAttemptCount: "2",
			errorCount: "0",
			trafficMode: "continuous",
		});
		expect(snapshot.lastReceivedAt).toBe(observation.completed_at);
		expect(observation).toMatchObject({
			version: "1",
			disposition: "success",
			poll_interval_ms: "60000",
			deposits_limit: "50",
			response_truncated: false,
			malformed_count: "0",
			error_reason: "",
		});
		expect(observation.completed_at).not.toBeNull();
		expect(observation.attempted_at <= String(observation.completed_at)).toBe(
			true,
		);
		expect(observation.observed_deposits).toEqual([
			{
				coin: "USDT",
				network: "ARBITRUM",
				external_id: "0xcovered",
				txid: "0xcovered",
				deposit_timestamp_ms: String(creditedTimestamp),
				status: "credited_not_withdrawable",
				progress: {
					state: "credited_not_withdrawable",
					progress_state: "valid",
					reason: null,
					native_status: "6",
					current: "3",
					credit_required: "12",
					unlock_required: "12",
					complete_time: null,
				},
			},
		]);
		expect(observation.request_since_ms).not.toBeNull();
	});

	test("marks a full page as truncated so omitted deposits are never proven absent", async () => {
		const page = Array.from({ length: 2 }, (_, index) => ({
			...credited,
			txid: `0xpage-${index}`,
			timestamp: credited.timestamp + index,
		}));
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => page,
		};
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			config: { depositsLimit: 2 },
			coveragePublisher: fakeCoveragePublisher(published),
		});

		await poller.pollAllOnce();

		const { observation } = lastObservation(published);
		expect(observation.disposition).toBe("success");
		expect(observation.response_truncated).toBe(true);
		expect(observation.observed_deposits).toHaveLength(2);

		// A venue answering past the requested limit is not partially trusted.
		const overflowing = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [...page, { ...credited, txid: "0xextra" }],
		};
		const overflowPublished: StreamHealthSnapshot[][] = [];
		const overflowPoller = new DepositArchivePoller({
			brokers: poolWith(overflowing),
			archiver: fakeArchiver([]),
			config: { depositsLimit: 2 },
			coveragePublisher: fakeCoveragePublisher(overflowPublished),
		});
		await overflowPoller.pollAllOnce();
		const overflow = lastObservation(overflowPublished).observation;
		expect(overflow.disposition).toBe("error");
		expect(overflow.observed_deposits).toEqual([]);
		expect(overflow.error_reason).toContain("limit of 2");
	});

	test("reports an empty answer as a completed poll that covers nothing", async () => {
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [],
		};
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			coveragePublisher: fakeCoveragePublisher(published),
		});

		await poller.pollAllOnce();

		const { observation } = lastObservation(published);
		expect(observation.disposition).toBe("success");
		expect(observation.completed_at).not.toBeNull();
		expect(observation.response_truncated).toBe(false);
		expect(observation.observed_deposits).toEqual([]);
		expect(observation.next_cursor_ms).toBeNull();
	});

	test("keeps a failing account in the batch beside a healthy sibling without a success clock", async () => {
		const healthy = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [credited],
		};
		const broken = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => {
				throw new Error("venue unavailable apiKey=secret");
			},
		};
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: {
				binance: {
					primary: account(healthy),
					secondaryBrokers: [account(broken, "secondary:1", 1)],
				},
			},
			archiver: fakeArchiver([]),
			coveragePublisher: fakeCoveragePublisher(published),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		const batch = published.at(-1);
		expect(batch).toHaveLength(2);
		const failing = lastObservation(published, "secondary:1");
		expect(failing.snapshot).toMatchObject({
			state: "error",
			lastFailureKind: "transport_error",
			connectAttemptCount: "2",
			errorCount: "2",
			lastConnectedAt: null,
			lastReceivedAt: null,
		});
		expect(failing.observation).toMatchObject({
			disposition: "error",
			completed_at: null,
			next_cursor_ms: null,
			response_truncated: null,
			observed_deposits: [],
		});
		expect(failing.observation.error_reason).toContain("venue unavailable");
		expect(lastObservation(published).snapshot.state).toBe("connected");
	});

	test("an empty venue error message still yields a valid explicit error observation", async () => {
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => {
				throw new Error("   ");
			},
		};
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			coveragePublisher: fakeCoveragePublisher(published),
		});

		await poller.pollAllOnce();

		const { snapshot, observation } = lastObservation(published);
		expect(observation.disposition).toBe("error");
		expect(observation.error_reason).toBe("fetchDeposits failed");
		expect(snapshot.lastFailureReason).toBe("fetchDeposits failed");
	});

	test("redacts the target exchange's credential literals from a persisted failure reason", async () => {
		const exchange = {
			has: { fetchDeposits: true },
			apiKey: "live-api-key-literal",
			secret: "live-secret-literal",
			fetchDeposits: async () => {
				throw new Error(
					"signature live-secret-literal rejected for live-api-key-literal",
				);
			},
		};
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			coveragePublisher: fakeCoveragePublisher(published),
		});

		await poller.pollAllOnce();

		const { snapshot, observation } = lastObservation(published);
		expect(observation.error_reason).not.toContain("live-secret-literal");
		expect(observation.error_reason).not.toContain("live-api-key-literal");
		expect(observation.error_reason).toContain("[redacted]");
		expect(snapshot.lastFailureReason).toBe(observation.error_reason);
	});

	test("a completion stamped before its attempt is an explicit error, never a success body", async () => {
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [],
		};
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			coveragePublisher: fakeCoveragePublisher(published),
		});
		// The host clock steps backwards between the attempt and the completion
		// read.
		const realNow = Date.prototype.toISOString;
		let calls = 0;
		const stamps = ["2026-08-03T20:00:10.000Z", "2026-08-03T20:00:00.000Z"];
		const spy = spyOn(Date.prototype, "toISOString").mockImplementation(
			function (this: Date) {
				const stamp = stamps[calls];
				calls += 1;
				return stamp ?? realNow.call(this);
			},
		);
		try {
			await poller.pollAllOnce();
		} finally {
			spy.mockRestore();
		}

		const { snapshot, observation } = lastObservation(published);
		expect(observation.disposition).toBe("error");
		expect(observation.completed_at).toBeNull();
		expect(observation.error_reason).toContain("source clock invalid");
		expect(snapshot.state).toBe("error");
	});

	test("recovering from an error counts a reconnect and clears the failure", async () => {
		let fail = true;
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => {
				if (fail) throw new Error("transient");
				return [];
			},
		};
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			coveragePublisher: fakeCoveragePublisher(published),
		});

		await poller.pollAllOnce();
		fail = false;
		await poller.pollAllOnce();

		const { snapshot, observation } = lastObservation(published);
		expect(snapshot).toMatchObject({
			state: "connected",
			lastFailureKind: "none",
			lastFailureReason: "",
			reconnectCount: "1",
			errorCount: "1",
			connectAttemptCount: "2",
		});
		expect(observation.disposition).toBe("success");
	});

	test("reports an unsupported connector as an unsupported observation every poll", async () => {
		const exchange = { has: { fetchDeposits: false } };
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			coveragePublisher: fakeCoveragePublisher(published),
		});

		await poller.pollAllOnce();
		await poller.pollAllOnce();

		expect(published).toHaveLength(2);
		const { snapshot, observation } = lastObservation(published);
		expect(snapshot).toMatchObject({
			state: "error",
			lastFailureKind: "unsupported_connector",
		});
		expect(observation).toMatchObject({
			disposition: "unsupported",
			completed_at: null,
			request_since_ms: null,
			error_reason: "",
			observed_deposits: [],
		});
	});

	test("stop hands the publisher the complete coverage set for its final post", async () => {
		const exchange = {
			has: { fetchDeposits: true },
			fetchDeposits: async () => [],
		};
		const published: StreamHealthSnapshot[][] = [];
		const poller = new DepositArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver([]),
			coveragePublisher: fakeCoveragePublisher(published),
		});
		await poller.pollAllOnce();
		await poller.stop();
		expect(published).toHaveLength(2);
		expect(published[1]).toEqual(published[0]);
	});
});
