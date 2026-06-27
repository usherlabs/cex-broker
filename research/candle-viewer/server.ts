import { createClient } from "@clickhouse/client";
import path from "path";
import {
	type CandleQuery,
	candleFingerprint,
	fetchCandles,
	type ChartCandle,
} from "./candles";
import { loadViewerConfig } from "./config";
import { PRICE_DECIMAL_PLACES } from "./format";

const config = loadViewerConfig();
const publicDir = path.join(import.meta.dir, "public");

const clickhouse = createClient({
	url: `http://${config.clickhouse.host}:${config.clickhouse.port}`,
	username: config.clickhouse.username,
	password: config.clickhouse.password,
	database: config.clickhouse.database,
});

type WsData = {
	type: "candles";
	exchange: string;
	symbol: string;
	timeframe: string;
	candles: ChartCandle[];
	updatedAt: string;
	total: number;
};

type WsClientState = {
	query: CandleQuery;
	lastFingerprint: string;
};

type WsSocket = ServerWebSocket<WsClientState>;

const wsClients = new Set<WsSocket>();
let pollRunning = false;
let pollInFlight = false;
let lastPollFinishedAt = Date.now();

async function pollAllClients(): Promise<void> {
	await Promise.allSettled(
		[...wsClients].map(async (ws) => {
			try {
				await loadAndMaybePush(ws);
			} catch (error) {
				console.error("Candle poll failed:", error);
			}
		}),
	);
}

async function runPollTick(): Promise<void> {
	if (pollInFlight) {
		return;
	}
	pollInFlight = true;
	try {
		await pollAllClients();
	} catch (error) {
		console.error("Candle poll loop failed:", error);
	} finally {
		pollInFlight = false;
		lastPollFinishedAt = Date.now();
		setTimeout(() => {
			void runPollTick();
		}, config.pollIntervalMs);
	}
}

function schedulePollLoop(): void {
	if (pollRunning) {
		return;
	}
	pollRunning = true;
	setTimeout(() => {
		void runPollTick();
	}, config.pollIntervalMs);
	setInterval(() => {
		if (
			!pollInFlight &&
			Date.now() - lastPollFinishedAt > config.pollIntervalMs * 4
		) {
			console.warn("Candle poll loop stalled; restarting");
			void runPollTick();
		}
	}, config.pollIntervalMs * 2);
}

function parseQuery(url: URL): CandleQuery {
	return {
		exchange:
			url.searchParams.get("exchange")?.trim() ||
			config.defaults.exchange,
		symbol: url.searchParams.get("symbol")?.trim() || config.defaults.symbol,
		timeframe:
			url.searchParams.get("timeframe")?.trim() ||
			config.defaults.timeframe,
		limit: Number.parseInt(
			url.searchParams.get("limit") ?? String(config.defaults.limit),
			10,
		),
	};
}

function normalizeLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) {
		return config.defaults.limit;
	}
	return Math.min(Math.trunc(limit), 2_000);
}

function sendCandles(ws: WsSocket, candles: ChartCandle[]): void {
	try {
		ws.send(
			JSON.stringify({
				type: "candles",
				exchange: ws.data.query.exchange,
				symbol: ws.data.query.symbol,
				timeframe: ws.data.query.timeframe,
				candles,
				updatedAt: new Date().toISOString(),
				total: candles.length,
			} satisfies WsData),
		);
	} catch (error) {
		console.error("Candle push failed; dropping client:", error);
		wsClients.delete(ws);
		try {
			ws.close();
		} catch {
			// ignore close errors on dead sockets
		}
	}
}

async function loadAndMaybePush(ws: WsSocket, force = false): Promise<void> {
	const candles = await fetchCandles(clickhouse, {
		...ws.data.query,
		limit: normalizeLimit(ws.data.query.limit),
	});
	const fingerprint = candleFingerprint(candles);
	if (!force && fingerprint === ws.data.lastFingerprint) {
		return;
	}
	ws.data.lastFingerprint = fingerprint;
	sendCandles(ws, candles);
}

const server = Bun.serve<WsClientState>({
	port: config.port,
	async fetch(request, bunServer) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			try {
				await clickhouse.ping();
				return Response.json({ status: "ok", clickhouse: true });
			} catch {
				return Response.json(
					{ status: "degraded", clickhouse: false },
					{ status: 503 },
				);
			}
		}

		if (url.pathname === "/api/candles") {
			const query = parseQuery(url);
			try {
				const candles = await fetchCandles(clickhouse, {
					...query,
					limit: normalizeLimit(query.limit),
				});
				return Response.json({
					exchange: query.exchange,
					symbol: query.symbol,
					timeframe: query.timeframe,
					candles,
					updatedAt: new Date().toISOString(),
					total: candles.length,
				});
			} catch (error) {
				return Response.json(
					{
						error: "Failed to load candles",
						detail: error instanceof Error ? error.message : String(error),
					},
					{ status: 500 },
				);
			}
		}

		if (url.pathname === "/api/config") {
			return Response.json({
				defaults: config.defaults,
				symbols: config.defaults.symbols,
				timeframes: ["1m", "5m", "15m", "1h"],
				baseTimeframe: "1m",
				pollIntervalMs: config.pollIntervalMs,
				priceDecimalPlaces: PRICE_DECIMAL_PLACES,
			});
		}

		if (url.pathname === "/ws") {
			const query = parseQuery(url);
			const upgraded = bunServer.upgrade(request, {
				data: {
					query: { ...query, limit: normalizeLimit(query.limit) },
					lastFingerprint: "",
				},
			});
			if (!upgraded) {
				return new Response("WebSocket upgrade failed", { status: 500 });
			}
			return undefined;
		}

		const filePath =
			url.pathname === "/"
				? path.join(publicDir, "index.html")
				: path.join(publicDir, url.pathname.replace(/^\//, ""));
		const file = Bun.file(filePath);
		if (!(await file.exists())) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(file);
	},
	websocket: {
		open(ws) {
			wsClients.add(ws);
			void loadAndMaybePush(ws, true).catch((error) => {
				console.error("Initial candle load failed:", error);
			});
		},
		close(ws) {
			wsClients.delete(ws);
		},
		message(ws, message) {
			try {
				const body = JSON.parse(String(message)) as {
					type?: string;
					exchange?: string;
					symbol?: string;
					timeframe?: string;
					limit?: number;
				};
				if (body.type !== "subscribe") {
					return;
				}
				ws.data.query = {
					exchange: body.exchange?.trim() || config.defaults.exchange,
					symbol: body.symbol?.trim() || config.defaults.symbol,
					timeframe:
						body.timeframe?.trim() || config.defaults.timeframe,
					limit: normalizeLimit(body.limit ?? config.defaults.limit),
				};
				ws.data.lastFingerprint = "";
				void loadAndMaybePush(ws, true).catch((error) => {
					console.error("Resubscribe candle load failed:", error);
				});
			} catch {
				// ignore malformed client messages
			}
		},
	},
});

schedulePollLoop();

console.log(
	`Candle viewer: http://localhost:${server.port} (poll ${config.pollIntervalMs}ms)`,
);
console.log(
	`ClickHouse: ${config.clickhouse.host}:${config.clickhouse.port}/${config.clickhouse.database}`,
);
