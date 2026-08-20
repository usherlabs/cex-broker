import { describe, expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { parquetWriteBuffer } from "hyparquet-writer";
import {
	CRYPTOHFTDATA_BINANCE_SPOT_BTCUSDT_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
	type CryptoHftDataError,
	cryptoHftDataCapabilityFor,
	decodeCryptoHftParquetZstd,
	enumerateCryptoHftDataObjects,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import { validBackfillRequest } from "./market-data-vendor-backfill-contract.test";

const JULY_2025 = Date.UTC(2025, 6, 1, 10, 10);
const provenProfiles = [
	CRYPTOHFTDATA_BINANCE_SPOT_BTCUSDT_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
];

function capability(request: ReturnType<typeof validBackfillRequest>) {
	const resolved = cryptoHftDataCapabilityFor(request, provenProfiles);
	if (!resolved) throw new Error("expected synthetic profile capability");
	return resolved;
}

describe("CryptoHFTData capability and acquisition", () => {
	test("discovers order-book symbols through the public credential-free endpoint", async () => {
		let observed: Request | undefined;
		const adapter = new CryptoHftDataAdapter({
			fetch: async (input, init) => {
				observed = new Request(input, init);
				return Response.json({
					exchange: "binance_spot",
					data_type: "orderbook",
					count: 3,
					symbols: ["ETHUSDT", "BTCUSDT", "BTCUSDT"],
				});
			},
		});
		expect(await adapter.discoverSymbols("binance_spot")).toEqual([
			"BTCUSDT",
			"ETHUSDT",
		]);
		expect(observed?.url).toBe(
			"https://api.cryptohftdata.com/symbols?exchange=binance_spot&data_type=orderbook",
		);
		expect(observed?.headers.get("authorization")).toBeNull();
		expect(observed?.headers.get("x-api-key")).toBeNull();
	});

	test("decodes a synthetic outer-Zstd Parquet object without subprocesses", async () => {
		const parquet = parquetWriteBuffer({
			columnData: [
				{
					name: "received_time",
					data: [1_751_364_600_000_000_000n],
					type: "INT64",
				},
				{ name: "event_time", data: [1_751_364_600_000n], type: "INT64" },
				{ name: "symbol", data: ["BTCUSDT"], type: "STRING" },
				{ name: "event_type", data: ["snapshot"], type: "STRING" },
				{ name: "side", data: ["bid"], type: "STRING" },
				{ name: "price", data: ["100.5"], type: "STRING" },
				{ name: "quantity", data: ["2"], type: "STRING" },
			],
		});
		const compressed = zstdCompressSync(new Uint8Array(parquet));
		const decoded = await decodeCryptoHftParquetZstd(compressed);
		expect(decoded).toHaveLength(1);
		expect(decoded[0]).toMatchObject({
			symbol: "BTCUSDT",
			event_type: "snapshot",
			side: "bid",
			price: "100.5",
			quantity: "2",
		});
	});

	test("supports only pinned Binance sampled authoritative profiles", () => {
		const supported = validBackfillRequest({
			scope: {
				exchange: "binance",
				tradingPair: "BTC-USDT",
				sourceSymbol: "BTCUSDT",
				marketType: "spot",
				feed: "ORDERBOOK",
			},
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [JULY_2025 + 30_000],
		});
		expect(cryptoHftDataCapabilityFor(supported)).toBeUndefined();
		expect(cryptoHftDataCapabilityFor(supported, provenProfiles)).toMatchObject(
			{
				providerExchangeId: "binance_spot",
				resolvedSymbol: "BTCUSDT",
				adapterVersion: "cryptohftdata-orderbook/v2",
			},
		);
		for (const request of [
			validBackfillRequest({
				...supported,
				scope: { ...supported.scope, exchange: "mexc" },
			}),
			validBackfillRequest({
				...supported,
				constructionMode: "exact_l2_reconstruction",
			}),
			validBackfillRequest({ ...supported, sourcePolicy: "fill_gaps" }),
		]) {
			expect(
				cryptoHftDataCapabilityFor(request, provenProfiles),
			).toBeUndefined();
		}
	});

	test("advertises the pinned OKX Spot ARB-USDT profile with v2 semantics", () => {
		const request = validBackfillRequest({
			providerPolicy: {
				provider: "cryptohftdata",
				allowedAdapterVersions: ["cryptohftdata-orderbook/v2"],
			},
			scope: {
				exchange: "okx",
				tradingPair: "ARB-USDT",
				sourceSymbol: "ARB-USDT",
				marketType: "spot",
				feed: "ORDERBOOK",
			},
			window: {
				startTimeMs: Date.UTC(2026, 7, 18, 9, 27, 15, 308),
				endTimeMs: Date.UTC(2026, 7, 18, 9, 28, 15, 308),
			},
			requiredClockTargetsMs: [Date.UTC(2026, 7, 18, 9, 27, 45, 308)],
			depth: 20,
		});

		expect(cryptoHftDataCapabilityFor(request, provenProfiles)).toEqual({
			provider: "cryptohftdata",
			adapterVersion: "cryptohftdata-orderbook/v2",
			providerExchangeId: "okx_spot",
			resolvedSymbol: "ARB-USDT",
		});
	});

	test("enumerates bounded UTC-hour object paths including initialization lookback", () => {
		const request = validBackfillRequest({
			window: {
				startTimeMs: Date.UTC(2025, 6, 1, 10, 10),
				endTimeMs: Date.UTC(2025, 6, 1, 11, 10),
			},
			requiredClockTargetsMs: [Date.UTC(2025, 6, 1, 10, 30)],
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 3,
				maxBoundaryLookbackMs: 3_600_000,
			},
		});
		expect(
			enumerateCryptoHftDataObjects(request, "binance_spot", "BTCUSDT"),
		).toEqual([
			"binance_spot/2025-07-01/09/BTCUSDT_orderbook.parquet.zst",
			"binance_spot/2025-07-01/10/BTCUSDT_orderbook.parquet.zst",
			"binance_spot/2025-07-01/11/BTCUSDT_orderbook.parquet.zst",
		]);
	});

	test("uses X-API-Key only for JWT issuance and bearer headers for downloads", async () => {
		const request = validBackfillRequest({
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [JULY_2025 + 30_000],
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 2,
				maxBoundaryLookbackMs: 0,
			},
		});
		const seen: Array<{
			url: string;
			authorization?: string;
			apiKey?: string;
		}> = [];
		const adapter = new CryptoHftDataAdapter({
			fetch: async (input, init) => {
				const headers = new Headers(init?.headers);
				seen.push({
					url: String(input),
					authorization: headers.get("authorization") ?? undefined,
					apiKey: headers.get("x-api-key") ?? undefined,
				});
				if (String(input).endsWith("/jwt-token")) {
					return Response.json({ jwt_token: "short-lived-jwt" });
				}
				return new Response(new Uint8Array([1, 2, 3]));
			},
			decode: async () => [
				{
					received_time: "1751364600000000000",
					event_time: "1751364600000",
					symbol: "BTCUSDT",
					event_type: "snapshot",
					last_update_id: "1",
					side: "bid",
					price: "100",
					quantity: "1",
				},
			],
		});
		const dataset = await adapter.acquire(request, capability(request), {
			apiKey: "long-lived-secret",
		});
		expect(dataset.objects).toHaveLength(1);
		expect(seen[0]).toMatchObject({ apiKey: "long-lived-secret" });
		expect(seen[1]?.authorization).toBe("Bearer short-lived-jwt");
		expect(seen.every(({ url }) => !url.includes("long-lived-secret"))).toBe(
			true,
		);
	});

	test("fails before fetching when the enumerated object count exceeds budget", async () => {
		let called = false;
		const request = validBackfillRequest({
			window: {
				startTimeMs: Date.UTC(2025, 6, 1, 10, 10),
				endTimeMs: Date.UTC(2025, 6, 1, 11, 10),
			},
			requiredClockTargetsMs: [Date.UTC(2025, 6, 1, 10, 30)],
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 1,
				maxBoundaryLookbackMs: 3_600_000,
			},
		});
		const adapter = new CryptoHftDataAdapter({
			fetch: async () => {
				called = true;
				return new Response();
			},
		});
		await expect(
			adapter.acquire(request, capability(request), {
				apiKey: "secret",
			}),
		).rejects.toMatchObject<Partial<CryptoHftDataError>>({
			reason: "budget_max_files_exceeded",
		});
		expect(called).toBe(false);
	});

	test.each([
		{
			name: "bytes",
			budgets: { maxBytes: 1 },
			decode: async () => [],
			reason: "budget_max_bytes_exceeded",
		},
		{
			name: "rows",
			budgets: { maxRows: 1 },
			decode: async () => [
				{
					received_time: "1751364600000000000",
					event_time: "1751364600000",
					symbol: "BTCUSDT",
					event_type: "snapshot",
					last_update_id: "1",
					side: "bid",
					price: "100",
					quantity: "1",
				},
				{
					received_time: "1751364600000000000",
					event_time: "1751364600000",
					symbol: "BTCUSDT",
					event_type: "snapshot",
					last_update_id: "1",
					side: "ask",
					price: "101",
					quantity: "1",
				},
			],
			reason: "budget_max_rows_exceeded",
		},
	] as const)("fails closed when the $name budget is exhausted", async ({
		budgets,
		decode,
		reason,
	}) => {
		const request = validBackfillRequest({
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [JULY_2025 + 30_000],
			budgets: {
				...validBackfillRequest().budgets,
				...budgets,
				maxFiles: 1,
				maxBoundaryLookbackMs: 0,
			},
		});
		const adapter = new CryptoHftDataAdapter({
			fetch: async (input) =>
				String(input).endsWith("/jwt-token")
					? Response.json({ jwt_token: "jwt" })
					: new Response(new Uint8Array([1, 2])),
			decode,
		});
		await expect(
			adapter.acquire(request, capability(request), {
				apiKey: "secret",
			}),
		).rejects.toMatchObject<Partial<CryptoHftDataError>>({ reason });
	});

	test("fails closed when the duration budget expires", async () => {
		const request = validBackfillRequest({
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [JULY_2025 + 30_000],
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 1,
				maxDurationMs: 1,
				maxBoundaryLookbackMs: 0,
			},
		});
		let clockCall = 0;
		let downloads = 0;
		const adapter = new CryptoHftDataAdapter({
			nowMs: () => (clockCall++ === 0 ? 0 : 2),
			fetch: async (input) => {
				if (String(input).endsWith("/jwt-token")) {
					return Response.json({ jwt_token: "jwt" });
				}
				downloads += 1;
				return new Response(new Uint8Array([1]));
			},
		});
		await expect(
			adapter.acquire(request, capability(request), {
				apiKey: "secret",
			}),
		).rejects.toMatchObject<Partial<CryptoHftDataError>>({
			reason: "budget_max_duration_exceeded",
		});
		expect(downloads).toBe(0);
	});

	test("hashes identical dataset bytes deterministically", async () => {
		const request = validBackfillRequest({
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [JULY_2025 + 30_000],
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 1,
				maxBoundaryLookbackMs: 0,
			},
		});
		const adapter = new CryptoHftDataAdapter({
			fetch: async (input) =>
				String(input).endsWith("/jwt-token")
					? Response.json({ jwt_token: "jwt" })
					: new Response(new Uint8Array([1, 2, 3])),
			decode: async () => [],
		});
		const providerCapability = capability(request);
		const first = await adapter.acquire(request, providerCapability, {
			apiKey: "secret",
		});
		const second = await adapter.acquire(request, providerCapability, {
			apiKey: "secret",
		});
		expect(first.objects[0]?.checksum).toBe(second.objects[0]?.checksum);
		expect(first.vendorSemanticDigest).toBe(second.vendorSemanticDigest);
	});

	test("normalizes reconstructed samples through shared canonical provenance without narrowing UInt64 sequences", async () => {
		const target = JULY_2025 + 30_000;
		const request = validBackfillRequest({
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [target],
			maxPriorAsOfLagMs: 60_000,
		});
		const object = {
			identity: "binance_spot/2025-07-01/10/BTCUSDT_orderbook.parquet.zst",
			checksum: "a".repeat(64),
			bytes: 123,
			rows: 2,
		};
		const sequence = "9007199254740993";
		const dataset = {
			objects: [object],
			vendorSemanticDigest: "b".repeat(64),
			rows: [
				{
					received_time: String(BigInt(target - 1_000) * 1_000_000n),
					event_time: String(target - 2_000),
					symbol: "BTCUSDT",
					event_type: "snapshot" as const,
					last_update_id: sequence,
					side: "bid" as const,
					price: "100",
					quantity: "1",
					dataset_object_identity: object.identity,
					dataset_object_checksum: object.checksum,
				},
				{
					received_time: String(BigInt(target - 1_000) * 1_000_000n),
					event_time: String(target - 2_000),
					symbol: "BTCUSDT",
					event_type: "snapshot" as const,
					last_update_id: sequence,
					side: "ask" as const,
					price: "101",
					quantity: "2",
					dataset_object_identity: object.identity,
					dataset_object_checksum: object.checksum,
				},
			],
		};
		const normalized = await new CryptoHftDataAdapter({
			profiles: provenProfiles,
		}).normalize(request, capability(request), dataset, "c".repeat(64));
		expect(normalized.rows).toHaveLength(3);
		for (const { row } of normalized.rows) {
			expect(row).toMatchObject({
				source: "external_backfill",
				deployment_id: "market-data-vendor-backfill",
				provider: "cryptohftdata",
				source_mode: "vendor_historical_backfill_v1",
				raw_capture_scope: "vendor_normalized_dataset_file",
				raw_checksum: object.checksum,
				sequence,
			});
			expect(row.normalized_row_checksum).toMatch(/^[a-f0-9]{64}$/);
		}
	});
});
