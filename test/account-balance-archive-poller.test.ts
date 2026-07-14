import { describe, expect, test } from "bun:test";
import { AccountBalanceArchivePoller } from "../src/helpers/account-balance-archive-poller";
import type { BrokerAccount, BrokerPoolEntry } from "../src/helpers/broker";
import type {
	BrokerArchiveRow,
	BrokerExecutionArchiver,
} from "../src/helpers/broker-execution-archive";
import type { OtelMetrics } from "../src/helpers/otel";

function account(
	exchange: unknown,
	label: BrokerAccount["label"],
	index?: number,
): BrokerAccount {
	return { exchange, label, index } as unknown as BrokerAccount;
}

function fakeArchiver(
	sink: BrokerArchiveRow[],
	durable = true,
): BrokerExecutionArchiver {
	return {
		canPersistAccountBalanceSnapshots: () => durable,
		getDeploymentId: () => "deploy-a",
		enqueue: (row: BrokerArchiveRow) => sink.push(row),
	} as unknown as BrokerExecutionArchiver;
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve = (_value: T) => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("AccountBalanceArchivePoller", () => {
	test("polls every primary and secondary sequentially with explicit spot scope and isolates failures", async () => {
		const calls: string[] = [];
		const params: unknown[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const exchange = (name: string, shouldFail = false) => ({
			fetchBalance: async (value: unknown) => {
				calls.push(name);
				params.push(value);
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight -= 1;
				if (shouldFail) {
					throw new Error("rate limited");
				}
				return {
					free: { USDC: 80 },
					used: { USDC: 20 },
					total: { USDC: 100 },
				};
			},
		});
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(exchange("primary"), "primary"),
				secondaryBrokers: [
					account(exchange("secondary:1", true), "secondary:1", 1),
					account(exchange("secondary:2"), "secondary:2", 2),
				],
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const counters: Array<{
			name: string;
			labels: Record<string, string | number>;
		}> = [];
		const gauges: Array<{
			name: string;
			labels: Record<string, string | number>;
		}> = [];
		const metrics = {
			recordCounter: async (
				name: string,
				_value: number,
				labels: Record<string, string | number>,
			) => counters.push({ name, labels }),
			recordGauge: async (
				name: string,
				_value: number,
				labels: Record<string, string | number>,
			) => gauges.push({ name, labels }),
		} as unknown as OtelMetrics;
		const poller = new AccountBalanceArchivePoller({
			brokers,
			archiver: fakeArchiver(sink),
			metrics,
		});

		expect(await poller.pollAllOnce()).toBe(true);

		expect(calls).toEqual(["primary", "secondary:1", "secondary:2"]);
		expect(params).toEqual([
			{ type: "spot" },
			{ type: "spot" },
			{ type: "spot" },
		]);
		expect(maxInFlight).toBe(1);
		expect(sink).toHaveLength(2);
		expect(sink.map((entry) => entry.row.account_selector)).toEqual([
			"primary",
			"secondary:2",
		]);
		expect(
			counters.filter(({ name }) => name.endsWith("attempts_total")),
		).toHaveLength(3);
		expect(
			counters.filter(({ name }) => name.endsWith("successes_total")),
		).toHaveLength(2);
		expect(
			counters.filter(({ name }) => name.endsWith("failures_total")),
		).toHaveLength(1);
		expect(gauges.map(({ name }) => name).sort()).toEqual([
			"cex_account_balance_poll_freshness_seconds",
			"cex_account_balance_poll_freshness_seconds",
			"cex_account_balance_poll_last_success_timestamp_seconds",
			"cex_account_balance_poll_last_success_timestamp_seconds",
		]);
		for (const metric of [...counters, ...gauges]) {
			expect(metric.labels).toMatchObject({
				exchange: "binance",
				balance_scope: "spot",
			});
			expect(["primary", "secondary:1", "secondary:2"]).toContain(
				metric.labels.account_selector,
			);
		}
	});

	test("rejects overlapping passes", async () => {
		const gate = deferred<unknown>();
		let calls = 0;
		const sink: BrokerArchiveRow[] = [];
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(
					{
						fetchBalance: () => {
							calls += 1;
							return gate.promise;
						},
					},
					"primary",
				),
				secondaryBrokers: [],
			},
		};
		const poller = new AccountBalanceArchivePoller({
			brokers,
			archiver: fakeArchiver(sink),
		});

		const first = poller.pollAllOnce();
		expect(await poller.pollAllOnce()).toBe(false);
		expect(calls).toBe(1);
		gate.resolve({ free: {}, used: {}, total: {} });
		expect(await first).toBe(true);
		expect(sink).toHaveLength(1);
	});

	test("stop waits for the active account and prevents later accounts and ticks", async () => {
		const gate = deferred<unknown>();
		const calls: string[] = [];
		const sink: BrokerArchiveRow[] = [];
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(
					{
						fetchBalance: () => {
							calls.push("primary");
							return gate.promise;
						},
					},
					"primary",
				),
				secondaryBrokers: [
					account(
						{
							fetchBalance: async () => {
								calls.push("secondary:1");
								return {};
							},
						},
						"secondary:1",
						1,
					),
				],
			},
		};
		const poller = new AccountBalanceArchivePoller({
			brokers,
			archiver: fakeArchiver(sink),
		});

		const pass = poller.pollAllOnce();
		const stopped = poller.stop();
		gate.resolve({ total: { USDC: 1 } });
		await stopped;
		await pass;

		expect(calls).toEqual(["primary"]);
		expect(await poller.pollAllOnce()).toBe(false);
	});

	test("does not advertise or poll balance coverage without a durable forwarder", async () => {
		let calls = 0;
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(
					{
						fetchBalance: async () => {
							calls += 1;
							return {};
						},
					},
					"primary",
				),
				secondaryBrokers: [],
			},
		};
		const poller = new AccountBalanceArchivePoller({
			brokers,
			archiver: fakeArchiver([], false),
		});

		poller.start();
		expect(await poller.pollAllOnce()).toBe(false);
		await Promise.resolve();
		expect(calls).toBe(0);
		await poller.stop();
	});
});
