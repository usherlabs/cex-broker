import { describe, expect, spyOn, test } from "bun:test";
import type { BrokerAccount, BrokerPoolEntry } from "../src/helpers/broker";
import type {
	BrokerArchiveRow,
	BrokerExecutionArchiver,
} from "../src/helpers/broker-execution-archive";
import {
	DepositArchivePoller,
	nextDepositCursor,
} from "../src/helpers/deposit-archive-poller";
import { log } from "../src/helpers/logger";

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
			status: "complete",
			timestamp: 1_775_000_000_000,
			creditedAt: "2026-04-01T12:00:00.000Z",
			info: { venueField: "preserved" },
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
			status: "complete",
			amount: "25.500000",
			address: "0xrecipient",
			network: "ARBITRUM",
			external_id: "0xdeposit",
			client_withdrawal_id: "",
			txid: "0xdeposit",
			result_index: 0,
			exchange_timestamp: "2026-04-01T12:00:00.000Z",
			payload_json: JSON.stringify(rawDeposit),
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
							status: "ok",
							timestamp: Date.now() + 10_000,
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
