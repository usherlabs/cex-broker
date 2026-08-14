import { describe, expect, test } from "bun:test";
import type { BrokerAccount, BrokerPoolEntry } from "../src/helpers/broker";
import {
	type BrokerArchiveRow,
	BrokerExecutionArchiveDurabilityError,
	type BrokerExecutionArchiver,
} from "../src/helpers/broker-execution-archive";
import type { OtelMetrics } from "../src/helpers/otel";
import { UserAssetArchivePoller } from "../src/helpers/user-asset-archive-poller";

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

const userAssetExchange = (
	response: unknown,
	onCall?: () => void,
): Record<string, unknown> => ({
	id: "binance",
	sapiV3PostAssetGetUserAsset: async () => {
		onCall?.();
		if (response instanceof Error) {
			throw response;
		}
		return response;
	},
});

describe("UserAssetArchivePoller", () => {
	test("snapshots the freeze bucket for every binance account and isolates failures", async () => {
		const calls: string[] = [];
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(
					userAssetExchange(
						[
							{
								asset: "USDC",
								free: "1",
								locked: "0",
								freeze: "118.5",
								withdrawing: "0",
							},
						],
						() => calls.push("primary"),
					),
					"primary",
				),
				secondaryBrokers: [
					account(
						userAssetExchange(new Error("rate limited"), () =>
							calls.push("secondary:1"),
						),
						"secondary:1",
						1,
					),
					account(
						userAssetExchange([], () => calls.push("secondary:2")),
						"secondary:2",
						2,
					),
				],
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const counters: Array<{
			name: string;
			labels: Record<string, string | number>;
		}> = [];
		const metrics = {
			recordCounter: async (
				name: string,
				_value: number,
				labels: Record<string, string | number>,
			) => counters.push({ name, labels }),
			recordGauge: async () => {},
		} as unknown as OtelMetrics;
		const poller = new UserAssetArchivePoller({
			brokers,
			archiver: fakeArchiver(sink),
			metrics,
		});

		expect(await poller.pollAllOnce()).toBe(true);

		expect(calls).toEqual(["primary", "secondary:1", "secondary:2"]);
		expect(sink).toHaveLength(2);
		expect(sink.map((entry) => entry.row.account_selector)).toEqual([
			"primary",
			"secondary:2",
		]);
		expect(sink[0]?.row).toMatchObject({
			balance_scope: "user_asset",
			freeze_balances: { USDC: "118.5" },
		});
		// The failed account leaves no row at all, so a reader sees an absent
		// snapshot rather than an account with nothing frozen.
		expect(
			counters.filter(({ name }) => name.endsWith("failures_total")),
		).toHaveLength(1);
		for (const metric of counters) {
			expect(metric.labels).toMatchObject({
				exchange: "binance",
				balance_scope: "user_asset",
			});
		}
	});

	test("counts a malformed venue response as a failed read instead of writing an empty snapshot", async () => {
		const sink: BrokerArchiveRow[] = [];
		const failures: string[] = [];
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(
					userAssetExchange({ code: -1121, msg: "Invalid symbol." }),
					"primary",
				),
				secondaryBrokers: [],
			},
		};
		const metrics = {
			recordCounter: async (name: string) => {
				if (name.endsWith("failures_total")) {
					failures.push(name);
				}
			},
			recordGauge: async () => {},
		} as unknown as OtelMetrics;

		expect(
			await new UserAssetArchivePoller({
				brokers,
				archiver: fakeArchiver(sink),
				metrics,
			}).pollAllOnce(),
		).toBe(true);

		expect(sink).toEqual([]);
		expect(failures).toHaveLength(1);
	});

	test("treats a binance account without the sapi method as a broken read, not an absent scope", async () => {
		const sink: BrokerArchiveRow[] = [];
		const failures: string[] = [];
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account({ id: "binance" }, "primary"),
				secondaryBrokers: [],
			},
		};
		const metrics = {
			recordCounter: async (name: string) => {
				if (name.endsWith("failures_total")) {
					failures.push(name);
				}
			},
			recordGauge: async () => {},
		} as unknown as OtelMetrics;

		await new UserAssetArchivePoller({
			brokers,
			archiver: fakeArchiver(sink),
			metrics,
		}).pollAllOnce();

		expect(sink).toEqual([]);
		expect(failures).toHaveLength(1);
	});

	test("does not poll venues that have no user-asset endpoint", async () => {
		const sink: BrokerArchiveRow[] = [];
		let calls = 0;
		const brokers: Record<string, BrokerPoolEntry> = {
			kraken: {
				primary: account(
					userAssetExchange([], () => {
						calls += 1;
					}),
					"primary",
				),
				secondaryBrokers: [],
			},
		};
		const poller = new UserAssetArchivePoller({
			brokers,
			archiver: fakeArchiver(sink),
		});

		poller.start();
		expect(await poller.pollAllOnce()).toBe(true);
		expect(calls).toBe(0);
		expect(sink).toEqual([]);
		await poller.stop();
	});

	test("rethrows archive durability failures instead of treating them as poll failures", async () => {
		const durabilityError = new BrokerExecutionArchiveDurabilityError(
			"loss journal write failed",
		);
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(
					userAssetExchange([
						{
							asset: "USDC",
							free: "1",
							locked: "0",
							freeze: "0",
							withdrawing: "0",
						},
					]),
					"primary",
				),
				secondaryBrokers: [],
			},
		};
		const archiver = {
			canPersistAccountBalanceSnapshots: () => true,
			getDeploymentId: () => "deploy-a",
			enqueue: () => {
				throw durabilityError;
			},
		} as unknown as BrokerExecutionArchiver;

		await expect(
			new UserAssetArchivePoller({ brokers, archiver }).pollAllOnce(),
		).rejects.toBe(durabilityError);
	});

	test("does not advertise or poll user-asset coverage without a durable forwarder", async () => {
		let calls = 0;
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(
					userAssetExchange([], () => {
						calls += 1;
					}),
					"primary",
				),
				secondaryBrokers: [],
			},
		};
		const poller = new UserAssetArchivePoller({
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
