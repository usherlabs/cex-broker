import { describe, expect, test } from "bun:test";
import type { BrokerAccount, BrokerPoolEntry } from "../src/helpers/broker";
import type {
	BrokerArchiveRow,
	BrokerExecutionArchiver,
} from "../src/helpers/broker-execution-archive";
import {
	FillArchivePoller,
	nextFillCursor,
} from "../src/helpers/fill-archive-poller";
import { OrderActivityTracker } from "../src/helpers/order-activity-tracker";

function fakeArchiver(sink: BrokerArchiveRow[]): BrokerExecutionArchiver {
	return {
		isEnabled: () => true,
		getDeploymentId: () => "deploy-a",
		enqueue: (row: BrokerArchiveRow) => sink.push(row),
	} as unknown as BrokerExecutionArchiver;
}

function poolWith(exchange: unknown): Record<string, BrokerPoolEntry> {
	const account = { exchange, label: "primary" } as unknown as BrokerAccount;
	return { binance: { primary: account, secondaryBrokers: [] } };
}

describe("OrderActivityTracker", () => {
	test("records distinct (exchange, account, symbol) and normalizes the exchange", () => {
		const tracker = new OrderActivityTracker();
		tracker.record("Binance", "primary", "USDC/USDT", 1_000);
		tracker.record("binance", "primary", "USDC/USDT", 2_000);
		tracker.record("binance", "secondary:1", "ARB/USDT", 2_000);

		const entries = tracker.list(2_000);
		expect(entries).toHaveLength(2);
		expect(entries).toContainEqual({
			exchangeId: "binance",
			accountLabel: "primary",
			symbol: "USDC/USDT",
			lastActivityAt: 2_000,
		});
	});

	test("ignores empty inputs and prunes entries past maxAge", () => {
		const tracker = new OrderActivityTracker({ maxAgeMs: 1_000 });
		tracker.record("binance", "", "USDC/USDT", 0);
		tracker.record("binance", "primary", "USDC/USDT", 0);

		expect(tracker.list(500)).toHaveLength(1);
		expect(tracker.list(2_000)).toHaveLength(0);
	});
});

describe("nextFillCursor", () => {
	test("advances past the newest trade timestamp, tolerating out-of-order batches", () => {
		expect(
			nextFillCursor(
				[{ timestamp: 100 }, { timestamp: 250 }, { timestamp: 200 }],
				0,
			),
		).toBe(251);
	});

	test("keeps the current cursor when the batch has no usable timestamps", () => {
		expect(nextFillCursor([], 42)).toBe(42);
		expect(nextFillCursor([{ id: "no-ts" }], 42)).toBe(42);
	});
});

describe("FillArchivePoller.pollTrackedOnce", () => {
	test("archives fetched trades and advances the cursor so the next poll is incremental", async () => {
		// Newer than the poller's lookback floor (now - 24h) so the cursor actually
		// advances past it on the first pass.
		const tradeTs = Date.now() + 10_000;
		const trades = [
			{
				id: "t-1",
				order: "o-1",
				side: "buy",
				price: 1,
				amount: 50,
				cost: 50,
				timestamp: tradeTs,
				fee: { cost: 0.05, currency: "USDC" },
			},
		];
		let calls = 0;
		let lastSince: number | undefined;
		const exchange = {
			has: { fetchMyTrades: true },
			fetchMyTrades: async (_symbol: string, since?: number) => {
				calls += 1;
				lastSince = since;
				return calls === 1 ? trades : [];
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const tracker = new OrderActivityTracker();
		tracker.record("binance", "primary", "USDC/USDT");
		const poller = new FillArchivePoller({
			brokers: poolWith(exchange),
			archiver: fakeArchiver(sink),
			tracker,
		});

		await poller.pollTrackedOnce();
		expect(sink).toHaveLength(1);
		expect(sink[0]?.table).toBe("broker_execution.fill_events");
		expect(sink[0]?.row).toMatchObject({
			order_id: "o-1",
			fill_id: "t-1",
			fill_index: 0,
			event_kind: "trade_history_fill",
			symbol: "USDC/USDT",
			account_selector: "primary",
		});

		// Second pass asks strictly after the last seen trade and archives nothing new.
		await poller.pollTrackedOnce();
		expect(calls).toBe(2);
		expect(lastSince).toBe(tradeTs + 1);
		expect(sink).toHaveLength(1);
	});

	test("skips accounts whose exchange has no fetchMyTrades", async () => {
		const sink: BrokerArchiveRow[] = [];
		const tracker = new OrderActivityTracker();
		tracker.record("binance", "primary", "USDC/USDT");
		const poller = new FillArchivePoller({
			brokers: poolWith({ has: { fetchMyTrades: false } }),
			archiver: fakeArchiver(sink),
			tracker,
		});

		await poller.pollTrackedOnce();
		expect(sink).toHaveLength(0);
	});

	test("a failing venue call does not stall the other tracked symbols", async () => {
		const good = {
			has: { fetchMyTrades: true },
			fetchMyTrades: async () => [
				{ id: "t-9", order: "o-9", timestamp: 5, price: 2, amount: 1, cost: 2 },
			],
		};
		const bad = {
			has: { fetchMyTrades: true },
			fetchMyTrades: async () => {
				throw new Error("rate limited");
			},
		};
		const account = (exchange: unknown, label: string, index?: number) =>
			({ exchange, label, index }) as unknown as BrokerAccount;
		const brokers: Record<string, BrokerPoolEntry> = {
			binance: {
				primary: account(bad, "primary"),
				secondaryBrokers: [account(good, "secondary:1", 1)],
			},
		};
		const sink: BrokerArchiveRow[] = [];
		const tracker = new OrderActivityTracker();
		tracker.record("binance", "primary", "USDC/USDT");
		tracker.record("binance", "secondary:1", "ARB/USDT");
		const poller = new FillArchivePoller({
			brokers,
			archiver: fakeArchiver(sink),
			tracker,
		});

		await poller.pollTrackedOnce();
		// The good account still produced its fill despite the bad account throwing.
		expect(sink).toHaveLength(1);
		expect(sink[0]?.row).toMatchObject({ fill_id: "t-9", symbol: "ARB/USDT" });
	});
});
