#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicBroker } from "../../../src/helpers/broker";
import {
	CHECKSUM_ALGORITHM,
	MARKET_CAPTURE_SCHEMA_VERSION,
	createRawCapture,
	sha256Canonical,
} from "../../../src/helpers/market-data-archive/capture-contract";
import {
	buildCanonicalCexStreamEventRow,
	buildCanonicalOhlcvRow,
} from "../../../src/helpers/market-data-archive/rows";
import type {
	MarketCaptureContext,
	ParsedOhlcvBar,
} from "../../../src/helpers/market-data-archive/types";

const MINUTE_MS = 60_000;
const PAGE_SIZE = 500;
const EXCHANGE = "binance";
const TIMEFRAME = "1m";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function timestamp(name: string): number {
	const value = Number(required(name));
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative millisecond timestamp`);
	}
	return value;
}

function parseSymbols(): string[] {
	const symbols = required("CEX_BROKER_OHLCV_BACKFILL_SYMBOLS")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (symbols.length === 0 || new Set(symbols).size !== symbols.length) {
		throw new Error("CEX_BROKER_OHLCV_BACKFILL_SYMBOLS must contain unique symbols");
	}
	for (const symbol of symbols) {
		if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(symbol)) {
			throw new Error(`Unsupported spot symbol: ${symbol}`);
		}
	}
	return symbols;
}

function parseBar(value: unknown, expectedOpenTimeMs: number): ParsedOhlcvBar {
	if (!Array.isArray(value) || value.length < 6) {
		throw new Error(`Invalid OHLCV row at ${expectedOpenTimeMs}`);
	}
	const [openTimeMs, open, high, low, close, volume] = value.map(Number);
	if (openTimeMs !== expectedOpenTimeMs) {
		throw new Error(
			`Expected candle ${expectedOpenTimeMs}, received ${openTimeMs}`,
		);
	}
	if (![open, high, low, close, volume].every(Number.isFinite)) {
		throw new Error(`Non-finite OHLCV value at ${expectedOpenTimeMs}`);
	}
	if (
		open <= 0 ||
		high <= 0 ||
		low <= 0 ||
		close <= 0 ||
		volume < 0 ||
		high < Math.max(open, close) ||
		low > Math.min(open, close) ||
		high < low
	) {
		throw new Error(`Invalid OHLCV invariants at ${expectedOpenTimeMs}`);
	}
	return { openTimeMs, open, high, low, close, volume };
}

function writeExclusive(path: string, value: unknown): string {
	const body = `${JSON.stringify(value, null, 2)}\n`;
	writeFileSync(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return createHash("sha256").update(body).digest("hex");
}

const startTimeMs = timestamp("CEX_BROKER_OHLCV_BACKFILL_START_MS");
const endTimeMs = timestamp("CEX_BROKER_OHLCV_BACKFILL_END_MS");
const receivedTimeMs = timestamp(
	"CEX_BROKER_OHLCV_BACKFILL_RECEIVED_TIME_MS",
);
if (
	endTimeMs <= startTimeMs ||
	startTimeMs % MINUTE_MS !== 0 ||
	endTimeMs % MINUTE_MS !== 0
) {
	throw new Error("Backfill window must be increasing and minute-aligned");
}
if (endTimeMs > Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS) {
	throw new Error("Backfill end must exclude the forming minute");
}
if (receivedTimeMs < endTimeMs) {
	throw new Error("Backfill received time must not precede the source window");
}

const symbols = parseSymbols();
const source = required("CEX_BROKER_OHLCV_BACKFILL_SOURCE");
if (source !== "broker_read" && source !== "broker_write") {
	throw new Error("CEX_BROKER_OHLCV_BACKFILL_SOURCE must be broker_read or broker_write");
}
const deploymentId = required("CEX_BROKER_OHLCV_BACKFILL_DEPLOYMENT_ID");
const captureBundleId = required("CEX_BROKER_OHLCV_BACKFILL_CAPTURE_BUNDLE_ID");
const outputDir = required("CEX_BROKER_OHLCV_BACKFILL_OUTPUT_DIR");
const expectedPerSymbol = (endTimeMs - startTimeMs) / MINUTE_MS;
mkdirSync(outputDir, { recursive: false, mode: 0o700 });

const exchange = createPublicBroker(EXCHANGE);
if (!exchange) throw new Error(`Unsupported public exchange: ${EXCHANGE}`);

const batches: Array<Record<string, unknown>> = [];
const allNormalizedChecksums: string[] = [];
let totalRows = 0;
try {
	for (const symbol of symbols) {
		let cursor = startTimeMs;
		let symbolRows = 0;
		while (cursor < endTimeMs) {
			const pageCount = Math.min(
				PAGE_SIZE,
				(endTimeMs - cursor) / MINUTE_MS,
			);
			const payload = await exchange.fetchOHLCV(
				symbol,
				TIMEFRAME,
				cursor,
				pageCount,
			);
			if (!Array.isArray(payload) || payload.length !== pageCount) {
				throw new Error(
					`${symbol} expected ${pageCount} rows at ${cursor}, received ${Array.isArray(payload) ? payload.length : "non-array"}`,
				);
			}
			const bars = payload.map((value, index) =>
				parseBar(value, cursor + index * MINUTE_MS),
			);
			const context: MarketCaptureContext = {
				source,
				deploymentId,
				captureBundleId,
				exchange: EXCHANGE,
				symbol,
				tradingPair: symbol.replace("/", "-"),
				sourceSymbol: symbol,
				assetType: "spot",
				accountSelector: "public_archive",
				feed: "OHLCV",
				provider: "ccxt:binance",
				sourceMode: "external_ccxt_fallback_v1",
				schemaVersion: MARKET_CAPTURE_SCHEMA_VERSION,
				checksumAlgorithm: CHECKSUM_ALGORITHM,
				provenanceComplete: true,
				timeframe: TIMEFRAME,
			};
			const rawCapture = createRawCapture(context, {
				payload,
				eventTimeMs: cursor,
				receivedTimeMs,
				scope: "ccxt_normalized_object",
			});
			const rows = [
				buildCanonicalCexStreamEventRow(context, rawCapture),
				...bars.map((bar) =>
					buildCanonicalOhlcvRow({
						context,
						rawCapture,
						bar,
						isClosed: true,
						brokerVersion: receivedTimeMs,
					}),
				),
			];
			const normalizedChecksums = rows.map((entry) =>
				String(entry.row.normalized_row_checksum),
			);
			allNormalizedChecksums.push(...normalizedChecksums);
			const pageEndTimeMs = cursor + pageCount * MINUTE_MS;
			const batchId = sha256Canonical({
				capture_bundle_id: captureBundleId,
				exchange: EXCHANGE,
				symbol,
				start_time_ms: cursor,
				end_time_ms: pageEndTimeMs,
				normalized_checksums: normalizedChecksums,
			});
			const envelope = {
				source,
				deployment_id: deploymentId,
				batch_id: batchId,
				rows,
			};
			const file = `batch-${String(batches.length).padStart(3, "0")}.json`;
			const sha256 = writeExclusive(join(outputDir, file), envelope);
			batches.push({
				file,
				sha256,
				batch_id: batchId,
				symbol,
				start_time_ms: cursor,
				end_time_ms: pageEndTimeMs,
				ohlcv_rows: pageCount,
				raw_rows: 1,
			});
			cursor = pageEndTimeMs;
			symbolRows += pageCount;
			totalRows += pageCount;
		}
		if (symbolRows !== expectedPerSymbol) {
			throw new Error(`${symbol} produced ${symbolRows}, expected ${expectedPerSymbol}`);
		}
	}
} finally {
	await exchange.close();
}

const manifest = {
	mode: "dry_run",
	exchange: EXCHANGE,
	timeframe: TIMEFRAME,
	symbols,
	window: { start_time_ms: startTimeMs, end_time_ms: endTimeMs },
	expected_rows_per_symbol: expectedPerSymbol,
	total_ohlcv_rows: totalRows,
	total_raw_rows: batches.length,
	source,
	deployment_id: deploymentId,
	capture_bundle_id: captureBundleId,
	received_time_ms: receivedTimeMs,
	provider: "ccxt:binance",
	source_mode: "external_ccxt_fallback_v1",
	raw_capture_scope: "ccxt_normalized_object",
	provenance_complete: true,
	schema_version: MARKET_CAPTURE_SCHEMA_VERSION,
	checksum_algorithm: CHECKSUM_ALGORITHM,
	normalized_checksums_sha256: sha256Canonical(allNormalizedChecksums),
	batches,
};
const manifestSha256 = writeExclusive(join(outputDir, "manifest.json"), manifest);
console.info(JSON.stringify({ ...manifest, manifest_sha256: manifestSha256 }, null, 2));
