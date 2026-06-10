import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import type { Exchange } from "@usherlabs/ccxt";
import WebSocket from "ws";

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
	on(event: "open", listener: () => void): unknown;
	on(event: "message", listener: (data: unknown) => void): unknown;
	on(event: "error", listener: (error: unknown) => void): unknown;
	on(
		event: "close",
		listener: (code: unknown, reason: unknown) => void,
	): unknown;
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

type WebSocketFactory = (url: string) => WebSocketLike;

let createWebSocket: WebSocketFactory = (url) =>
	new WebSocket(url) as WebSocketLike;

export function setBinanceUserDataWebSocketFactoryForTests(
	factory: WebSocketFactory,
): () => void {
	const previous = createWebSocket;
	createWebSocket = factory;
	return () => {
		createWebSocket = previous;
	};
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

function getRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function getMessage(value: unknown): string | null {
	if (value instanceof Error) {
		return value.message;
	}
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	const record = getRecord(value);
	const message = record?.message;
	return typeof message === "string" && message.length > 0 ? message : null;
}

function getOptionalExchangeString(
	exchange: Exchange,
	key: "apiKey" | "secret",
): string | null {
	const value = exchange[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function redactDiagnosticMessage(
	message: string,
	secretValues: readonly string[],
): string {
	let redacted = message;
	for (const value of secretValues) {
		if (value.length > 0) {
			redacted = redacted.split(value).join("[redacted]");
		}
	}
	return redacted
		.replace(
			/(\b(?:apiKey|secret|signature)\b\s*=\s*)[^\s&,;)]+/gi,
			"$1[redacted]",
		)
		.replace(
			/("(?:apiKey|secret|signature)"\s*:\s*")[^"]*(")/gi,
			"$1[redacted]$2",
		);
}

function formatBinanceUserDataWebSocketError(
	event: unknown,
	secretValues: readonly string[],
): Error {
	const record = getRecord(event);
	const message =
		getMessage(record?.error) ??
		getMessage(record?.message) ??
		getMessage(event);
	const safeMessage =
		message === null ? null : redactDiagnosticMessage(message, secretValues);
	return new Error(
		safeMessage
			? `Binance user-data WebSocket error: ${safeMessage}`
			: "Binance user-data WebSocket error",
	);
}

function getCloseReason(value: unknown): string | null {
	if (typeof value === "string") {
		return value.length > 0 ? value : null;
	}
	if (Buffer.isBuffer(value)) {
		const reason = value.toString("utf8");
		return reason.length > 0 ? reason : null;
	}
	if (value instanceof Uint8Array) {
		const reason = Buffer.from(value).toString("utf8");
		return reason.length > 0 ? reason : null;
	}
	return null;
}

function formatBinanceUserDataWebSocketClose(
	codeOrEvent: unknown,
	reasonOrUndefined: unknown,
	secretValues: readonly string[],
): Error {
	const record = getRecord(codeOrEvent);
	const code = record ? record.code : codeOrEvent;
	const reason = getCloseReason(record ? record.reason : reasonOrUndefined);
	const safeReason =
		reason === null ? null : redactDiagnosticMessage(reason, secretValues);
	const details = [
		typeof code === "number" || typeof code === "string"
			? `code=${code}`
			: null,
		safeReason ? `reason=${safeReason}` : null,
	].filter((detail): detail is string => detail !== null);
	return new Error(
		details.length > 0
			? `Binance user-data WebSocket closed unexpectedly (${details.join(", ")})`
			: "Binance user-data WebSocket closed unexpectedly",
	);
}

function decodeMessageData(data: unknown): unknown {
	if (typeof data === "string") {
		return data;
	}
	if (Buffer.isBuffer(data)) {
		return data.toString("utf8");
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("utf8");
	}
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
			"utf8",
		);
	}
	if (Array.isArray(data) && data.every((item) => Buffer.isBuffer(item))) {
		return Buffer.concat(data).toString("utf8");
	}
	return data;
}

export class BinanceSpotUserDataStream
	implements AsyncIterable<BinanceUserDataEvent>
{
	private readonly ws: WebSocketLike;
	private readonly secretValues: string[];
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
		this.secretValues = [
			getOptionalExchangeString(exchange, "apiKey"),
			getOptionalExchangeString(exchange, "secret"),
		].filter((value): value is string => value !== null);
		this.ws = createWebSocket(getBinanceSpotWsApiUrl(exchange));
		this.ws.on("open", () => this.subscribe());
		this.ws.on("message", (data) => this.handleMessage(data));
		this.ws.on("error", (error) =>
			this.fail(formatBinanceUserDataWebSocketError(error, this.secretValues)),
		);
		this.ws.on("close", (code, reason) => this.handleClose(code, reason));
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

	private handleClose(code: unknown, reason: unknown): void {
		if (this.closed) {
			return;
		}
		this.fail(
			formatBinanceUserDataWebSocketClose(code, reason, this.secretValues),
		);
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
			const decodedData = decodeMessageData(data);
			message =
				typeof decodedData === "string"
					? (JSON.parse(decodedData) as BinanceUserDataMessage)
					: (decodedData as BinanceUserDataMessage);
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
