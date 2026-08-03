import type { RowInserter } from "../../../../services/archive-forwarder/insert";
import type { ArchiveBatchRequest } from "../../../../services/archive-forwarder/types";

export type PublicFeed = "ORDERBOOK" | "TICKER" | "TRADES" | "OHLCV";

export const PUBLIC_FEEDS = [
	"ORDERBOOK",
	"TICKER",
	"TRADES",
	"OHLCV",
] as const satisfies readonly PublicFeed[];

export class LifecycleBarrier<T = void> {
	public readonly promise: Promise<T>;
	private resolvePromise!: (value: T | PromiseLike<T>) => void;
	private rejectPromise!: (reason?: unknown) => void;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolvePromise = resolve;
			this.rejectPromise = reject;
		});
	}

	public resolve(...args: T extends void ? [] : [value: T]): void {
		this.resolvePromise(args[0] as T);
	}

	public reject(reason: unknown): void {
		this.rejectPromise(reason);
	}
}

export class FixedArchiveClock {
	constructor(private readonly timestampMs: number) {}

	public now(): number {
		return this.timestampMs;
	}

	public date(): Date {
		return new Date(this.timestampMs);
	}
}

export type InserterController = {
	inserter: RowInserter;
	requestStarted: LifecycleBarrier<void>;
	release: () => void;
	attempts: number;
};

export type ArchiveForwarderEndpoint = {
	url: string;
	requestCount: number;
	batches: ArchiveBatchRequest[];
	close: () => Promise<void>;
};

export type FeedLink = {
	feed: PublicFeed;
	rawCaptureId: string;
	normalizedTables: string[];
};

export type ArchiveLifecycleResult = {
	collectorModule: string;
	feedsObserved: PublicFeed[];
	streamsActiveBeforeAbort: PublicFeed[];
	legacyRowsMatchBaseline: boolean;
	feedLinks: FeedLink[];
	unexpectedDestinations: string[];
	checksumsVerified: boolean;
	conflictViewsEmpty: boolean;
	legacyOrderBookRows: number;
	legacyCandleRows: number;
};

export type ArchiveFailureResult = {
	laterFramesObservedBeforeRelease: PublicFeed[];
	streamsActiveBeforeAbort: PublicFeed[];
	retryAttempts: number;
	emittedRows: number;
	storedRows: number;
	journalRows: number;
	journalReasons: string[];
	unaccountedRows: number;
};
