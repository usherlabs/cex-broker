import { describe, expect, test } from "bun:test";
import { zstdCompressSync } from "node:zlib";
import { parquetWriteBuffer } from "hyparquet-writer";
import { sha256Canonical } from "../src/helpers/market-data-archive/capture-contract";
import {
	CRYPTOHFTDATA_BINANCE_SPOT_BTCUSDT_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	CryptoHftDataAdapter,
	type CryptoHftDataError,
	cryptoHftDataCapabilityFor,
	decodeCryptoHftParquetZstd,
	enumerateCryptoHftDataObjects,
	providerAcquisitionRequest,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import { validBackfillRequest } from "./market-data-vendor-backfill-contract.test";

const JULY_2025 = Date.UTC(2025, 6, 1, 10, 10);
const provenProfiles = [
	CRYPTOHFTDATA_BINANCE_SPOT_BTCUSDT_PROFILE,
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE,
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
		expect(
			cryptoHftDataCapabilityFor(
				validBackfillRequest({ ...request, sourcePolicy: "fill_gaps" }),
				provenProfiles,
			),
		).toEqual({
			provider: "cryptohftdata",
			adapterVersion: "cryptohftdata-orderbook/v2",
			providerExchangeId: "okx_spot",
			resolvedSymbol: "ARB-USDT",
		});
	});

	test("advertises the pinned OKX Spot ARB-USDC profile with v2 semantics", () => {
		const request = validBackfillRequest({
			providerPolicy: {
				provider: "cryptohftdata",
				allowedAdapterVersions: ["cryptohftdata-orderbook/v2"],
			},
			scope: {
				exchange: "okx",
				tradingPair: "ARB-USDC",
				sourceSymbol: "ARB-USDC",
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
			resolvedSymbol: "ARB-USDC",
		});
		expect(
			cryptoHftDataCapabilityFor(
				validBackfillRequest({ ...request, sourcePolicy: "fill_gaps" }),
				provenProfiles,
			),
		).toMatchObject({ resolvedSymbol: "ARB-USDC" });
	});

	test("fill_gaps acquires only required-clock targets not covered by retained archive anchors", () => {
		const first = Date.UTC(2026, 7, 18, 9, 15);
		const covered = Date.UTC(2026, 7, 18, 10, 15);
		const missing = Date.UTC(2026, 7, 18, 12, 15);
		const request = validBackfillRequest({
			sourcePolicy: "fill_gaps",
			window: { startTimeMs: first, endTimeMs: missing + 60_000 },
			requiredClockTargetsMs: [first, covered, missing],
			maxPriorAsOfLagMs: 60_000,
			budgets: {
				...validBackfillRequest().budgets,
				maxBoundaryLookbackMs: 3_600_000,
			},
			initialSelection: {
				...({} as NonNullable<
					ReturnType<typeof validBackfillRequest>["initialSelection"]
				>),
				support_anchors: [
					{
						capture_bundle_id: "a".repeat(64),
						raw_capture_id: "b".repeat(64),
						snapshot_id: "c".repeat(64),
						source_time: new Date(covered - 1_000).toISOString(),
						normalized_summary_checksum: "d".repeat(64),
						metadata_ref: {
							capture_origin: "production_capture",
							qualification_event_id: null,
							receipt_id: null,
						},
					},
				],
			},
		});

		const acquisition = providerAcquisitionRequest(request);
		expect(acquisition.requiredClockTargetsMs).toEqual([first, missing]);
		expect(
			enumerateCryptoHftDataObjects(acquisition, "okx_spot", "ARB-USDT"),
		).toEqual([
			"okx_spot/2026-08-18/08/ARB-USDT_orderbook.parquet.zst",
			"okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst",
			"okx_spot/2026-08-18/11/ARB-USDT_orderbook.parquet.zst",
			"okx_spot/2026-08-18/12/ARB-USDT_orderbook.parquet.zst",
		]);
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

	test("streams OKX objects into required-clock books without retaining raw updates", async () => {
		const firstHour = Date.UTC(2026, 7, 18, 9);
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
			window: { startTimeMs: firstHour, endTimeMs: firstHour + 2 * 3_600_000 },
			requiredClockTargetsMs: [
				firstHour + 30 * 60_000,
				firstHour + 90 * 60_000,
			],
			maxPriorAsOfLagMs: 5_000,
			sourcePolicy: "fill_gaps",
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 2,
				maxBoundaryLookbackMs: 0,
			},
		});
		let objectIndex = 0;
		const adapter = new CryptoHftDataAdapter({
			profiles: provenProfiles,
			fetch: async (input) =>
				String(input).endsWith("/jwt-token")
					? Response.json({ jwt_token: "jwt" })
					: new Response(new Uint8Array([++objectIndex])),
			decode: async () => {
				const hour = firstHour + (objectIndex - 1) * 3_600_000;
				const snapshotSequence = String(200 + objectIndex * 100);
				const updateSequence = String(Number(snapshotSequence) + 1);
				return [
					...(["bid", "ask"] as const).map((side) => ({
						received_time: String(BigInt(hour + 1_000) * 1_000_000n),
						event_time: String(hour),
						symbol: "ARB-USDT",
						event_type: "snapshot",
						first_update_id: null,
						final_update_id: snapshotSequence,
						prev_final_update_id: null,
						last_update_id: "-1",
						side,
						price: side === "bid" ? "99" : "101",
						quantity: "10",
					})),
					...(["bid", "ask"] as const).map((side) => ({
						received_time: String(BigInt(hour + 30 * 60_000) * 1_000_000n),
						event_time: String(hour + 30 * 60_000 - 1_000),
						symbol: "ARB-USDT",
						event_type: "update",
						first_update_id: null,
						final_update_id: updateSequence,
						prev_final_update_id: null,
						last_update_id: snapshotSequence,
						side,
						price: side === "bid" ? "99" : "101",
						quantity: "11",
					})),
				];
			},
		});
		const providerCapability = capability(request);
		const dataset = await adapter.acquire(request, providerCapability, {
			apiKey: "secret",
		});

		expect(dataset.rows).toEqual([]);
		expect(dataset.reconstructedBooks).toHaveLength(2);
		const normalized = await adapter.normalize(
			request,
			providerCapability,
			dataset,
			"c".repeat(64),
		);
		expect(normalized.rows).toHaveLength(6);
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

	test("attributes opaque provider object failures without reflecting error text", async () => {
		const secret = "provider-response-secret";
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
			decode: async () => {
				throw new Error(`opaque decoder failure ${secret}`);
			},
		});

		let caught: CryptoHftDataError | undefined;
		try {
			await adapter.acquire(request, capability(request), { apiKey: "secret" });
		} catch (error) {
			caught = error as CryptoHftDataError;
		}
		expect(caught).toMatchObject({
			reason: "provider_object_decode_failed",
			diagnostics: {
				dataset_object_identity:
					"binance_spot/2025-07-01/10/BTCUSDT_orderbook.parquet.zst",
				failure_phase: "decode",
			},
		});
		expect(JSON.stringify(caught)).not.toContain(secret);
	});

	test("retries only the failed provider object and admits its stable successful bytes", async () => {
		const request = validBackfillRequest({
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [JULY_2025 + 30_000],
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 1,
				maxBoundaryLookbackMs: 0,
			},
		});
		let downloads = 0;
		const adapter = new CryptoHftDataAdapter({
			fetch: async (input) => {
				if (String(input).endsWith("/jwt-token")) {
					return Response.json({ jwt_token: "jwt" });
				}
				downloads += 1;
				if (downloads === 1) throw new Error("transient provider failure");
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
			apiKey: "secret",
		});

		expect(downloads).toBe(2);
		expect(dataset.objects).toHaveLength(1);
		expect(dataset.rows).toHaveLength(1);
	});

	test("quarantines a stable corrupt provider object after three attempts", async () => {
		const request = validBackfillRequest({
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [JULY_2025 + 30_000],
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 1,
				maxBoundaryLookbackMs: 0,
			},
		});
		let downloads = 0;
		const adapter = new CryptoHftDataAdapter({
			fetch: async (input) => {
				if (String(input).endsWith("/jwt-token")) {
					return Response.json({ jwt_token: "jwt" });
				}
				downloads += 1;
				return new Response(new Uint8Array([1, 2, 3]));
			},
			decode: async () => {
				throw new Error("corrupt parquet");
			},
		});

		await expect(
			adapter.acquire(request, capability(request), { apiKey: "secret" }),
		).rejects.toMatchObject<Partial<CryptoHftDataError>>({
			reason: "provider_object_decode_failed",
			diagnostics: {
				attempt_count: 3,
				quarantined: true,
				dataset_object_checksum:
					"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			},
		});
		expect(downloads).toBe(3);
	});

	test("quarantines a provider object whose bytes change between retries", async () => {
		const request = validBackfillRequest({
			window: { startTimeMs: JULY_2025, endTimeMs: JULY_2025 + 60_000 },
			requiredClockTargetsMs: [JULY_2025 + 30_000],
			budgets: {
				...validBackfillRequest().budgets,
				maxFiles: 1,
				maxBoundaryLookbackMs: 0,
			},
		});
		let downloads = 0;
		const adapter = new CryptoHftDataAdapter({
			fetch: async (input) => {
				if (String(input).endsWith("/jwt-token")) {
					return Response.json({ jwt_token: "jwt" });
				}
				downloads += 1;
				return new Response(new Uint8Array([downloads]));
			},
			decode: async () => {
				throw new Error("corrupt parquet");
			},
		});

		await expect(
			adapter.acquire(request, capability(request), { apiKey: "secret" }),
		).rejects.toMatchObject<Partial<CryptoHftDataError>>({
			reason: "provider_object_checksum_conflict",
			diagnostics: {
				attempt_count: 2,
				quarantined: true,
			},
		});
		expect(downloads).toBe(2);
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
		const providerCapability = capability(request);
		const first = await adapter.acquire(request, providerCapability, {
			apiKey: "secret",
		});
		const second = await adapter.acquire(request, providerCapability, {
			apiKey: "secret",
		});
		expect(first.objects[0]?.checksum).toBe(second.objects[0]?.checksum);
		expect(first.vendorSemanticDigest).toBe(second.vendorSemanticDigest);
		expect(first.vendorSemanticDigest).toBe(sha256Canonical(first.rows));
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

	test("reports safe required-clock context for canonical normalization failures", async () => {
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

		await expect(
			new CryptoHftDataAdapter({ profiles: provenProfiles }).normalize(
				request,
				capability(request),
				{
					objects: [object],
					vendorSemanticDigest: "b".repeat(64),
					rows: [],
					reconstructedBooks: [
						{
							targetTimeMs: target,
							sourceTimeMs: target - 1_000,
							receivedTimeMs: target,
							sequence: "1",
							bids: [
								[100, 1],
								[100, 2],
							],
							asks: [[101, 1]],
							datasetObjectIdentity: object.identity,
							datasetObjectChecksum: object.checksum,
						},
					],
				},
				"c".repeat(64),
			),
		).rejects.toMatchObject<Partial<CryptoHftDataError>>({
			reason: "canonical_orderbook_invalid",
			diagnostics: {
				target_time_ms: target,
				source_time_ms: target - 1_000,
				validation_reason: "bid levels are not strictly descending",
			},
		});
	});

	test("attributes opaque canonical failures to the required-clock sample", async () => {
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

		await expect(
			new CryptoHftDataAdapter({ profiles: provenProfiles }).normalize(
				request,
				capability(request),
				{
					objects: [object],
					vendorSemanticDigest: "b".repeat(64),
					rows: [],
					reconstructedBooks: [
						{
							targetTimeMs: target,
							sourceTimeMs: target - 1_000,
							receivedTimeMs: target,
							sequence: "1",
							bids: null as unknown as number[][],
							asks: [[101, 1]],
							datasetObjectIdentity: object.identity,
							datasetObjectChecksum: object.checksum,
						},
					],
				},
				"c".repeat(64),
			),
		).rejects.toMatchObject<Partial<CryptoHftDataError>>({
			reason: "canonical_normalization_failed",
			diagnostics: {
				target_time_ms: target,
				source_time_ms: target - 1_000,
				dataset_object_identity: object.identity,
				failure_phase: "normalize",
			},
		});
	});
});
