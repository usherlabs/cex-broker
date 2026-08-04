import type { Exchange } from "@usherlabs/ccxt";
import {
	BinanceSpotUserDataStream,
	type BinanceUserDataEvent,
	type BinanceUserDataStreamFailureKind,
	isBinanceBalanceUserDataEvent,
	isBinanceOrderUserDataEvent,
} from "./binance-user-data-stream";
import type { BrokerAccount, BrokerPoolEntry } from "./broker";
import { redactSecretLiterals } from "./broker-execution-archive/redact";
import type {
	StreamHealthFailureKind,
	StreamHealthPublisher,
	StreamHealthSnapshot,
} from "./stream-health-publisher";

const MAX_SUBSCRIBER_EVENTS = 16;

export type UserDataSubscriptionKind = "balance" | "orders";
export type UserDataSubscription = AsyncIterable<BinanceUserDataEvent> & {
	close(): void;
};
export type UserDataStreamSupervisorOptions = {
	brokers: Record<string, BrokerPoolEntry>;
	publisher: StreamHealthPublisher;
};

type UserDataSubscriptionOptions = {
	exchange: string;
	accountSelector: string;
	kind: UserDataSubscriptionKind;
	marketId?: string;
};

function now(): string {
	return new Date().toISOString();
}

function retryDelay(attempt: number): number {
	return Math.min(1_000 * 2 ** attempt, 30_000);
}

function safeFailureReason(exchange: Exchange, reason: string): string {
	const secrets = [exchange.apiKey, exchange.secret].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	return redactSecretLiterals(reason, secrets)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 256);
}

class Subscriber implements UserDataSubscription {
	readonly #queue: BinanceUserDataEvent[] = [];
	readonly #waiters: Array<{
		resolve: (event: BinanceUserDataEvent | null) => void;
		reject: (error: Error) => void;
	}> = [];
	#closed = false;
	#error: Error | null = null;

	constructor(
		readonly kind: UserDataSubscriptionKind,
		readonly marketId: string | undefined,
		private readonly onClose: () => void,
	) {}

	push(message: BinanceUserDataEvent): void {
		if (this.#closed || !this.#matches(message.event)) return;
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter.resolve(message);
			return;
		}
		if (this.#queue.length >= MAX_SUBSCRIBER_EVENTS) {
			this.#fail(
				new Error("Configured account user-data subscriber fell behind"),
			);
			return;
		}
		this.#queue.push(message);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue.length = 0;
		this.onClose();
		for (const waiter of this.#waiters.splice(0)) waiter.resolve(null);
	}

	async *[Symbol.asyncIterator](): AsyncIterator<BinanceUserDataEvent> {
		while (true) {
			const event = await this.#next();
			if (!event) return;
			yield event;
		}
	}

	#matches(event: Record<string, unknown>): boolean {
		if (this.kind === "balance") return isBinanceBalanceUserDataEvent(event);
		if (!isBinanceOrderUserDataEvent(event)) return false;
		return !this.marketId || event.s === this.marketId;
	}

	#next(): Promise<BinanceUserDataEvent | null> {
		const event = this.#queue.shift();
		if (event) return Promise.resolve(event);
		if (this.#error) return Promise.reject(this.#error);
		if (this.#closed) return Promise.resolve(null);
		return new Promise((resolve, reject) =>
			this.#waiters.push({ resolve, reject }),
		);
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#error = error;
		this.#queue.length = 0;
		this.onClose();
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}
}

class AccountWorker {
	readonly #subscribers = new Set<Subscriber>();
	#snapshot: StreamHealthSnapshot;
	#stopping = false;
	#stream: BinanceSpotUserDataStream | null = null;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#retryResolve: (() => void) | null = null;
	#run: Promise<void> | null = null;
	#failureObserved = false;
	#attempts = 0;

	constructor(
		private readonly exchangeName: string,
		private readonly account: BrokerAccount,
		private readonly onChange: () => void,
	) {
		const timestamp = now();
		this.#snapshot = {
			exchange: exchangeName,
			accountSelector: account.label,
			accountRole: account.role,
			streamKind: "user_data",
			accountScope: "spot",
			registryStatus: "active",
			retiredAt: null,
			state: "connecting",
			stateChangedAt: timestamp,
			lastConnectedAt: null,
			lastAuthenticatedAt: null,
			lastReceivedAt: null,
			connectAttemptCount: "0",
			reconnectCount: "0",
			errorCount: "0",
			lastFailureKind: "none",
			lastFailureReason: "",
			trafficMode: "event_driven",
			sourceWatermark: null,
		};
	}

	start(): void {
		if (this.exchangeName !== "binance") {
			this.#fail(
				"unsupported_connector",
				"Configured exchange has no user-data supervisor",
			);
			return;
		}
		this.#run = this.#connectLoop();
	}

	subscribe(
		options: Omit<UserDataSubscriptionOptions, "exchange" | "accountSelector">,
	): UserDataSubscription {
		if (this.#stopping)
			throw new Error("Configured account user-data supervisor is stopping");
		const subscriber = new Subscriber(options.kind, options.marketId, () => {
			this.#subscribers.delete(subscriber);
		});
		this.#subscribers.add(subscriber);
		return subscriber;
	}

	snapshot(): StreamHealthSnapshot {
		return { ...this.#snapshot };
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#retryTimer) clearTimeout(this.#retryTimer);
		this.#retryTimer = null;
		this.#retryResolve?.();
		this.#retryResolve = null;
		this.#stream?.close();
		await this.#run;
		this.#transition("disconnected", "shutdown", "Broker shutdown");
		for (const subscriber of [...this.#subscribers]) subscriber.close();
	}

	#transition(
		state: StreamHealthSnapshot["state"],
		failureKind?: StreamHealthFailureKind,
		failureReason?: string,
	): void {
		const timestamp = now();
		if (this.#snapshot.state !== state) {
			this.#snapshot.state = state;
			this.#snapshot.stateChangedAt = timestamp;
		}
		if (failureKind) {
			this.#snapshot.lastFailureKind = failureKind;
			this.#snapshot.lastFailureReason = failureReason ?? "";
		}
		this.onChange();
	}

	#connected(): void {
		this.#snapshot.lastConnectedAt = now();
		this.#transition("connected");
	}

	#authenticated(): void {
		this.#snapshot.lastAuthenticatedAt = now();
		this.onChange();
	}

	#received(message: BinanceUserDataEvent): void {
		this.#snapshot.lastReceivedAt = now();
		const eventTimestamp = message.event.E;
		this.#snapshot.sourceWatermark =
			typeof eventTimestamp === "number" || typeof eventTimestamp === "string"
				? String(eventTimestamp).slice(0, 512)
				: null;
		for (const subscriber of this.#subscribers) subscriber.push(message);
		this.onChange();
	}

	#fail(kind: StreamHealthFailureKind, reason: string): void {
		this.#failureObserved = true;
		this.#snapshot.errorCount = (
			BigInt(this.#snapshot.errorCount) + 1n
		).toString();
		this.#transition(
			"error",
			kind,
			safeFailureReason(this.account.exchange, reason),
		);
	}

	async #connectLoop(): Promise<void> {
		while (!this.#stopping) {
			if (this.#attempts > 0) {
				this.#snapshot.reconnectCount = (
					BigInt(this.#snapshot.reconnectCount) + 1n
				).toString();
			}
			this.#attempts += 1;
			this.#snapshot.connectAttemptCount = String(this.#attempts);
			this.#failureObserved = false;
			this.#transition("connecting");
			const stream = new BinanceSpotUserDataStream(this.account.exchange, {
				observer: {
					onConnected: () => this.#connected(),
					onAuthenticated: () => this.#authenticated(),
					onEvent: (message) => this.#received(message),
					onFailure: (failure) => this.#handleStreamFailure(failure),
				},
			});
			this.#stream = stream;
			try {
				for await (const _event of stream) {
					// Observer delivery fans out before this drain advances the socket queue.
				}
			} catch (error) {
				if (!this.#stopping && !this.#failureObserved) {
					this.#fail(
						"transport_error",
						error instanceof Error ? error.message : "User-data stream failed",
					);
				}
			} finally {
				stream.close();
				if (this.#stream === stream) this.#stream = null;
			}
			if (!this.#stopping) await this.#waitForRetry();
		}
	}

	#handleStreamFailure(failure: {
		kind: BinanceUserDataStreamFailureKind;
		reason: string;
	}): void {
		this.#fail(failure.kind, failure.reason);
	}

	#waitForRetry(): Promise<void> {
		return new Promise((resolve) => {
			const delay = retryDelay(Math.max(this.#attempts - 1, 0));
			this.#retryResolve = resolve;
			this.#retryTimer = setTimeout(() => {
				this.#retryTimer = null;
				this.#retryResolve = null;
				resolve();
			}, delay);
			this.#retryTimer.unref?.();
		});
	}
}

/** Owns one physical authenticated venue stream for each configured account. */
export class UserDataStreamSupervisor {
	readonly #workers = new Map<string, AccountWorker>();
	#started = false;

	constructor(private readonly options: UserDataStreamSupervisorOptions) {
		for (const [exchange, pool] of Object.entries(options.brokers)) {
			for (const account of [pool.primary, ...pool.secondaryBrokers]) {
				const normalizedExchange = exchange.trim().toLowerCase();
				const worker = new AccountWorker(normalizedExchange, account, () =>
					this.#publish(),
				);
				this.#workers.set(`${normalizedExchange}|${account.label}`, worker);
			}
		}
		if (this.#workers.size === 0) {
			throw new Error(
				"User-data supervisor requires at least one configured account",
			);
		}
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.options.publisher.start();
		for (const worker of this.#workers.values()) worker.start();
		this.#publish();
	}

	subscribe(options: UserDataSubscriptionOptions): UserDataSubscription {
		const exchange = options.exchange.trim().toLowerCase();
		const worker = this.#workers.get(`${exchange}|${options.accountSelector}`);
		if (!worker)
			throw new Error("Configured account user-data stream is unavailable");
		return worker.subscribe({ kind: options.kind, marketId: options.marketId });
	}

	async close(): Promise<void> {
		for (const worker of this.#workers.values()) await worker.stop();
		await this.options.publisher.close(this.#snapshots());
	}

	#snapshots(): StreamHealthSnapshot[] {
		return [...this.#workers.values()].map((worker) => worker.snapshot());
	}

	#publish(): void {
		if (!this.#started) return;
		this.options.publisher.publish(this.#snapshots());
	}
}
