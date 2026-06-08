import { createHmac } from "node:crypto";
import type { Exchange } from "@usherlabs/ccxt";

export const BINANCE_SPOT_WS_API_URL = "wss://ws-api.binance.com:443/ws-api/v3";

export type BinanceUserDataEvent = {
	subscriptionId: number;
	event: Record<string, unknown>;
};

type BinanceUserDataMessage =
	| {
			id?: string;
			status?: number;
			error?: { msg?: string; message?: string };
			result?: { subscriptionId?: number };
	  }
	| {
			subscriptionId?: number;
			event?: Record<string, unknown>;
	  };

type WebSocketLike = {
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: unknown) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

type WebSocketConstructor = new (url: string) => WebSocketLike;

function getWebSocketConstructor(): WebSocketConstructor {
	const WebSocketCtor = globalThis.WebSocket as unknown as
		| WebSocketConstructor
		| undefined;
	if (!WebSocketCtor) {
		throw new Error("WebSocket is not available in this runtime");
	}
	return WebSocketCtor;
}

function getExchangeString(
	exchange: Exchange,
	key: "apiKey" | "secret",
): string {
	const value = exchange[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Binance user-data stream requires exchange.${key}`);
	}
	return value;
}

function sortedQuery(params: Record<string, string | number>): string {
	return Object.entries(params)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(
			([key, value]) =>
				`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
		)
		.join("&");
}

function signUserDataStreamParams(
	exchange: Exchange,
	params: Record<string, string | number>,
): Record<string, string | number> {
	const signParams = (exchange as unknown as { signParams?: unknown })
		.signParams;
	if (typeof signParams === "function") {
		return signParams.call(exchange, params) as Record<string, string | number>;
	}

	const secret = getExchangeString(exchange, "secret");
	return {
		...params,
		signature: createHmac("sha256", secret)
			.update(sortedQuery(params))
			.digest("hex"),
	};
}

export function getBinanceSpotWsApiUrl(exchange: Exchange): string {
	const urls = (
		exchange as unknown as {
			urls?: {
				api?: { ws?: { "ws-api"?: { spot?: string } } };
			};
		}
	).urls;
	return urls?.api?.ws?.["ws-api"]?.spot ?? BINANCE_SPOT_WS_API_URL;
}

export class BinanceSpotUserDataStream
	implements AsyncIterable<BinanceUserDataEvent>
{
	private readonly ws: WebSocketLike;
	private readonly requestId = `user-data-${Date.now()}-${Math.random()}`;
	private readonly queue: BinanceUserDataEvent[] = [];
	private readonly waiters: Array<{
		resolve: (event: BinanceUserDataEvent | null) => void;
		reject: (error: Error) => void;
	}> = [];
	private closed = false;
	private closeError: Error | null = null;
	private subscriptionId: number | null = null;

	constructor(private readonly exchange: Exchange) {
		const WebSocketCtor = getWebSocketConstructor();
		this.ws = new WebSocketCtor(getBinanceSpotWsApiUrl(exchange));
		this.ws.onopen = () => this.subscribe();
		this.ws.onmessage = (message) => this.handleMessage(message.data);
		this.ws.onerror = (error) =>
			this.fail(
				error instanceof Error
					? error
					: new Error("Binance user-data WebSocket error"),
			);
		this.ws.onclose = () => this.close();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<BinanceUserDataEvent> {
		while (true) {
			const event = await this.nextEvent();
			if (!event) {
				break;
			}
			yield event;
		}
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		try {
			this.ws.close();
		} catch {
			// Closing is best-effort; stream cancellation should still unblock waiters.
		}
		this.flushWaiters();
	}

	private subscribe(): void {
		const apiKey = getExchangeString(this.exchange, "apiKey");
		const signedParams = signUserDataStreamParams(this.exchange, {
			apiKey,
			timestamp: Date.now(),
		});
		this.ws.send(
			JSON.stringify({
				id: this.requestId,
				method: "userDataStream.subscribe.signature",
				params: signedParams,
			}),
		);
	}

	private handleMessage(data: unknown): void {
		let message: BinanceUserDataMessage;
		try {
			message =
				typeof data === "string"
					? (JSON.parse(data) as BinanceUserDataMessage)
					: (data as BinanceUserDataMessage);
		} catch (error) {
			this.fail(
				error instanceof Error
					? error
					: new Error("Invalid Binance user-data message"),
			);
			return;
		}

		if ("id" in message && message.id === this.requestId) {
			if (message.status !== 200) {
				this.fail(
					new Error(
						message.error?.msg ??
							message.error?.message ??
							`Binance user-data subscription failed with status ${message.status}`,
					),
				);
				return;
			}
			this.subscriptionId = message.result?.subscriptionId ?? null;
			return;
		}

		if (!("event" in message) || !message.event) {
			return;
		}
		const subscriptionId = message.subscriptionId ?? this.subscriptionId;
		if (subscriptionId === null || subscriptionId === undefined) {
			return;
		}
		this.push({ subscriptionId, event: message.event });
	}

	private push(event: BinanceUserDataEvent): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve(event);
			return;
		}
		this.queue.push(event);
	}

	private nextEvent(): Promise<BinanceUserDataEvent | null> {
		const event = this.queue.shift();
		if (event) {
			return Promise.resolve(event);
		}
		if (this.closeError) {
			return Promise.reject(this.closeError);
		}
		if (this.closed) {
			return Promise.resolve(null);
		}
		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	private fail(error: Error): void {
		if (this.closeError) {
			return;
		}
		this.closeError = error;
		this.closed = true;
		this.flushWaiters();
		try {
			this.ws.close();
		} catch {
			// Closing is best-effort after an already surfaced failure.
		}
	}

	private flushWaiters(): void {
		const error = this.closeError;
		for (const waiter of this.waiters.splice(0)) {
			if (error) {
				waiter.reject(error);
			} else {
				waiter.resolve(null);
			}
		}
	}
}

export function isBinanceBalanceUserDataEvent(
	event: Record<string, unknown>,
): boolean {
	return (
		event.e === "outboundAccountPosition" ||
		event.e === "balanceUpdate" ||
		event.e === "externalLockUpdate"
	);
}

export function isBinanceOrderUserDataEvent(
	event: Record<string, unknown>,
): boolean {
	return event.e === "executionReport" || event.e === "listStatus";
}
