import { describe, expect, test } from "bun:test";
import { BalanceUpdateArchiveConsumer } from "../src/helpers/balance-update-archive-consumer";
import type { BinanceUserDataEvent } from "../src/helpers/binance-user-data-stream";
import type { BrokerAccount, BrokerPoolEntry } from "../src/helpers/broker";
import type {
	BrokerArchiveRow,
	BrokerExecutionArchiver,
} from "../src/helpers/broker-execution-archive";
import type {
	UserDataStreamSupervisor,
	UserDataSubscription,
} from "../src/helpers/user-data-stream-supervisor";

type SubscriptionStep = BinanceUserDataEvent | Error;

class FakeSubscription implements UserDataSubscription {
	#closed = false;
	#resolveClosed = () => {};
	readonly #closedPromise = new Promise<void>((resolve) => {
		this.#resolveClosed = resolve;
	});

	constructor(private readonly steps: SubscriptionStep[]) {}

	get closed(): boolean {
		return this.#closed;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#resolveClosed();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<BinanceUserDataEvent> {
		for (const step of this.steps) {
			await Promise.resolve();
			if (this.#closed) return;
			if (step instanceof Error) throw step;
			yield step;
		}
		await this.#closedPromise;
	}
}

function userDataEvent(event: Record<string, unknown>): BinanceUserDataEvent {
	return { subscriptionId: 7, event };
}

function brokers(): Record<string, BrokerPoolEntry> {
	return {
		binance: {
			primary: {
				exchange: {},
				label: "primary",
			} as unknown as BrokerAccount,
			secondaryBrokers: [],
		},
	};
}

function fakeArchiver(rows: BrokerArchiveRow[]): BrokerExecutionArchiver {
	return {
		getDeploymentId: () => "deploy-a",
		enqueue: (row: BrokerArchiveRow) => rows.push(row),
	} as unknown as BrokerExecutionArchiver;
}

function fakeSupervisor(subscriptions: FakeSubscription[]): {
	supervisor: Pick<UserDataStreamSupervisor, "subscribe">;
	calls: Array<Parameters<UserDataStreamSupervisor["subscribe"]>[0]>;
} {
	const calls: Array<Parameters<UserDataStreamSupervisor["subscribe"]>[0]> = [];
	return {
		calls,
		supervisor: {
			subscribe: (options) => {
				calls.push(options);
				const subscription = subscriptions.shift();
				if (!subscription) throw new Error("Unexpected subscription");
				return subscription;
			},
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for condition");
}

describe("BalanceUpdateArchiveConsumer", () => {
	test("archives only balanceUpdate events with venue fields preserved", async () => {
		const positive = {
			e: "balanceUpdate",
			E: 1_721_000_000_001,
			a: "USDC",
			d: "125.50000000",
			T: 1_721_000_000_000,
		};
		const negative = {
			e: "balanceUpdate",
			E: 1_721_000_100_001,
			a: "BTC",
			d: "-0.01500000",
			T: 1_721_000_100_000,
		};
		const subscription = new FakeSubscription([
			userDataEvent(positive),
			userDataEvent(negative),
			userDataEvent({
				e: "outboundAccountPosition",
				E: 1_721_000_200_000,
				B: [],
			}),
			userDataEvent({
				e: "externalLockUpdate",
				E: 1_721_000_300_000,
				a: "USDC",
				d: "1.0",
			}),
		]);
		const { supervisor, calls } = fakeSupervisor([subscription]);
		const rows: BrokerArchiveRow[] = [];
		const consumer = new BalanceUpdateArchiveConsumer({
			brokers: brokers(),
			archiver: fakeArchiver(rows),
			userDataStreamSupervisor: supervisor,
		});

		consumer.start();
		await waitFor(() => rows.length === 2);
		await consumer.stop();

		expect(calls).toEqual([
			{ exchange: "binance", accountSelector: "primary", kind: "balance" },
		]);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.table).toBe("broker_execution.transfer_events");
		expect(rows[0]?.row).toMatchObject({
			source: "broker_write",
			deployment_id: "deploy-a",
			schema_version: "1",
			account_selector: "primary",
			exchange: "binance",
			symbol: "unknown",
			event_kind: "balance_delta",
			lifecycle_action: "observe_balance_update",
			status: "",
			asset_symbol: "USDC",
			amount: "125.50000000",
			external_id: "",
			client_withdrawal_id: "",
			result_index: 0,
			exchange_timestamp: new Date(positive.T).toISOString(),
			payload_json: JSON.stringify(positive),
		});
		expect(rows[0]?.row).not.toHaveProperty("txid");
		expect(rows[1]?.row).toMatchObject({
			symbol: "unknown",
			event_kind: "balance_delta",
			lifecycle_action: "observe_balance_update",
			status: "",
			asset_symbol: "BTC",
			amount: "-0.01500000",
			external_id: "",
			exchange_timestamp: new Date(negative.T).toISOString(),
			payload_json: JSON.stringify(negative),
		});
		expect(rows[1]?.row).not.toHaveProperty("txid");
	});

	test("resubscribes after subscriber failure without replaying archived events", async () => {
		const firstEvent = {
			e: "balanceUpdate",
			E: 1_721_000_000_001,
			a: "USDC",
			d: "10",
			T: 1_721_000_000_000,
		};
		const secondEvent = {
			e: "balanceUpdate",
			E: 1_721_000_010_001,
			a: "USDT",
			d: "20",
			T: 1_721_000_010_000,
		};
		const first = new FakeSubscription([
			userDataEvent(firstEvent),
			new Error("Configured account user-data subscriber fell behind"),
		]);
		const second = new FakeSubscription([userDataEvent(secondEvent)]);
		const { supervisor, calls } = fakeSupervisor([first, second]);
		const rows: BrokerArchiveRow[] = [];
		const consumer = new BalanceUpdateArchiveConsumer({
			brokers: brokers(),
			archiver: fakeArchiver(rows),
			userDataStreamSupervisor: supervisor,
		});

		consumer.start();
		await waitFor(() => rows.length === 2 && calls.length === 2);
		await consumer.stop();

		expect(calls).toHaveLength(2);
		expect(rows.map(({ row }) => row.payload_json)).toEqual([
			JSON.stringify(firstEvent),
			JSON.stringify(secondEvent),
		]);
	});

	test("shutdown closes the subscription without resubscribing", async () => {
		const subscription = new FakeSubscription([]);
		const { supervisor, calls } = fakeSupervisor([subscription]);
		const consumer = new BalanceUpdateArchiveConsumer({
			brokers: brokers(),
			archiver: fakeArchiver([]),
			userDataStreamSupervisor: supervisor,
		});

		consumer.start();
		await waitFor(() => calls.length === 1);
		await consumer.stop();
		await Promise.resolve();

		expect(subscription.closed).toBe(true);
		expect(calls).toHaveLength(1);
	});
});
