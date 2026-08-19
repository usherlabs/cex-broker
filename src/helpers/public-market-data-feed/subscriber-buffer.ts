import { Buffer } from "node:buffer";
import type { SubscriptionType } from "../constants";

export type PublicFeedFrame = {
	data: string;
	timestamp: number;
	symbol: string;
	type: SubscriptionType;
};

export const PUBLIC_FEED_SUBSCRIBER_FRAME_LIMIT = 16;
export const PUBLIC_FEED_SUBSCRIBER_BYTE_LIMIT = 1024 * 1024;
export const PUBLIC_FEED_SUBSCRIBER_OVERFLOW_ERROR =
	"Public market-data subscriber fell behind";

function unsignedVarintSize(value: number): number {
	if (!Number.isFinite(value)) return 10;
	if (value < 0) return 10;
	let remaining = Math.floor(value);
	let size = 1;
	while (remaining >= 128) {
		remaining = Math.floor(remaining / 128);
		size += 1;
	}
	return size;
}

function stringFieldSize(fieldNumber: number, value: string): number {
	if (value.length === 0) return 0;
	const bytes = Buffer.byteLength(value, "utf8");
	return (
		unsignedVarintSize(fieldNumber << 3) + unsignedVarintSize(bytes) + bytes
	);
}

function varintFieldSize(fieldNumber: number, value: number): number {
	if (value === 0) return 0;
	return unsignedVarintSize(fieldNumber << 3) + unsignedVarintSize(value);
}

/** Returns the proto3 wire size of the complete SubscribeResponse message. */
export function encodeSubscribeResponseWireSize(
	response: PublicFeedFrame,
): number {
	return (
		stringFieldSize(1, response.data) +
		varintFieldSize(2, response.timestamp) +
		stringFieldSize(3, response.symbol) +
		varintFieldSize(4, response.type)
	);
}

type Waiter = {
	resolve: (result: IteratorResult<PublicFeedFrame>) => void;
	reject: (error: Error) => void;
};

export type PublicFeedSubscriberBufferOptions = {
	/** Test-only override. Production callers omit this value. */
	frameLimit?: number;
	/** Test-only override. Production callers omit this value. */
	byteLimit?: number;
};

/** Fixed-capacity O(1) FIFO for disposable public gRPC subscriber frames. */
export class PublicFeedSubscriberBuffer
	implements AsyncIterable<PublicFeedFrame>
{
	readonly frameLimit: number;
	readonly byteLimit: number;
	readonly #frames: Array<PublicFeedFrame | undefined>;
	readonly #sizes: number[];
	readonly #waiters: Waiter[] = [];
	#head = 0;
	#tail = 0;
	#count = 0;
	#bytes = 0;
	#closed = false;
	#error: Error | null = null;

	constructor(options: PublicFeedSubscriberBufferOptions = {}) {
		this.frameLimit = options.frameLimit ?? PUBLIC_FEED_SUBSCRIBER_FRAME_LIMIT;
		this.byteLimit = options.byteLimit ?? PUBLIC_FEED_SUBSCRIBER_BYTE_LIMIT;
		if (!Number.isInteger(this.frameLimit) || this.frameLimit <= 0) {
			throw new Error("Public feed subscriber frame limit must be positive");
		}
		if (!Number.isInteger(this.byteLimit) || this.byteLimit <= 0) {
			throw new Error("Public feed subscriber byte limit must be positive");
		}
		this.#frames = new Array(this.frameLimit);
		this.#sizes = new Array(this.frameLimit).fill(0);
	}

	get queuedFrames(): number {
		return this.#count;
	}

	get queuedBytes(): number {
		return this.#bytes;
	}

	enqueue(frame: PublicFeedFrame): boolean {
		if (this.#closed) return false;
		const size = encodeSubscribeResponseWireSize(frame);
		if (this.#count >= this.frameLimit || this.#bytes + size > this.byteLimit) {
			this.fail(new Error(PUBLIC_FEED_SUBSCRIBER_OVERFLOW_ERROR));
			return false;
		}

		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter.resolve({ done: false, value: frame });
			return true;
		}

		this.#frames[this.#tail] = frame;
		this.#sizes[this.#tail] = size;
		this.#tail = (this.#tail + 1) % this.frameLimit;
		this.#count += 1;
		this.#bytes += size;
		return true;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clear();
		for (const waiter of this.#waiters.splice(0)) {
			waiter.resolve({ done: true, value: undefined });
		}
	}

	fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#error = error;
		this.#clear();
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}

	[Symbol.asyncIterator](): AsyncIterator<PublicFeedFrame> {
		return { next: () => this.#next() };
	}

	#next(): Promise<IteratorResult<PublicFeedFrame>> {
		if (this.#count > 0) {
			const frame = this.#frames[this.#head];
			const size = this.#sizes[this.#head] ?? 0;
			this.#frames[this.#head] = undefined;
			this.#sizes[this.#head] = 0;
			this.#head = (this.#head + 1) % this.frameLimit;
			this.#count -= 1;
			this.#bytes -= size;
			return Promise.resolve({ done: false, value: frame as PublicFeedFrame });
		}
		if (this.#error) return Promise.reject(this.#error);
		if (this.#closed) {
			return Promise.resolve({ done: true, value: undefined });
		}
		return new Promise((resolve, reject) => {
			this.#waiters.push({ resolve, reject });
		});
	}

	#clear(): void {
		this.#frames.fill(undefined);
		this.#sizes.fill(0);
		this.#head = 0;
		this.#tail = 0;
		this.#count = 0;
		this.#bytes = 0;
	}
}
