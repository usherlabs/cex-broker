import { describe, expect, test } from "bun:test";
import {
	CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
	type CryptoHftDataOrderBookRow,
	reconstructCryptoHftDataOrderBooks,
} from "../src/helpers/market-data-vendor-backfill/cryptohftdata";
import { validBackfillRequest } from "./market-data-vendor-backfill-contract.test";

const target = Date.UTC(2025, 6, 1, 10, 0, 2);
const okxSnapshotTime = Date.UTC(2026, 7, 18, 9, 27, 15, 308);
const okxTarget = okxSnapshotTime + 30_000;

function event(
	overrides: Partial<CryptoHftDataOrderBookRow>,
): CryptoHftDataOrderBookRow {
	return {
		received_time: String((BigInt(target) - 1_000n) * 1_000_000n),
		event_time: String(target - 2_000),
		symbol: "BTCUSDT",
		event_type: "snapshot",
		last_update_id: "10",
		side: "bid",
		price: "100",
		quantity: "1",
		dataset_object_identity: "binance_spot/object.parquet.zst",
		dataset_object_checksum: "a".repeat(64),
		...overrides,
	};
}

function okxEvent(
	overrides: Partial<CryptoHftDataOrderBookRow>,
): CryptoHftDataOrderBookRow {
	return {
		received_time: String(BigInt(okxSnapshotTime + 1_000) * 1_000_000n),
		event_time: String(okxSnapshotTime),
		symbol: "ARB-USDT",
		event_type: "snapshot",
		first_update_id: null,
		final_update_id: "200",
		prev_final_update_id: null,
		last_update_id: "-1",
		side: "bid",
		price: "100",
		quantity: "1",
		dataset_object_identity:
			"okx_spot/2026-08-18/09/ARB-USDT_orderbook.parquet.zst",
		dataset_object_checksum: "b".repeat(64),
		...overrides,
	};
}

function okxRequest() {
	return validBackfillRequest({
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
			startTimeMs: okxSnapshotTime,
			endTimeMs: okxSnapshotTime + 60_000,
		},
		requiredClockTargetsMs: [okxTarget],
		maxPriorAsOfLagMs: 60_000,
	});
}

describe("CryptoHFTData snapshot/update reconstruction", () => {
	test("resets on a snapshot, applies replacements/deletions, and samples prior-as-of", () => {
		const request = validBackfillRequest({
			window: { startTimeMs: target - 5_000, endTimeMs: target + 1_000 },
			requiredClockTargetsMs: [target],
			maxPriorAsOfLagMs: 5_000,
		});
		const reconstructed = reconstructCryptoHftDataOrderBooks(request, [
			event({ side: "bid", price: "100", quantity: "1" }),
			event({ side: "bid", price: "99", quantity: "2" }),
			event({ side: "ask", price: "101", quantity: "3" }),
			event({ side: "ask", price: "102", quantity: "4" }),
			event({
				event_type: "update",
				event_time: String(target - 1_000),
				first_update_id: "11",
				final_update_id: "11",
				prev_final_update_id: "10",
				last_update_id: null,
				side: "bid",
				price: "100",
				quantity: "0",
			}),
			event({
				event_type: "update",
				event_time: String(target - 1_000),
				first_update_id: "11",
				final_update_id: "11",
				prev_final_update_id: "10",
				last_update_id: null,
				side: "bid",
				price: "99",
				quantity: "5",
			}),
		]);
		expect(reconstructed).toHaveLength(1);
		expect(reconstructed[0]).toMatchObject({
			targetTimeMs: target,
			sourceTimeMs: target - 1_000,
			sequence: "11",
			bids: [[99, 5]],
			asks: [
				[101, 3],
				[102, 4],
			],
		});
	});

	test("fails closed on a Binance update-chain gap", () => {
		const request = validBackfillRequest({
			window: { startTimeMs: target - 5_000, endTimeMs: target + 1_000 },
			requiredClockTargetsMs: [target],
			maxPriorAsOfLagMs: 5_000,
		});
		expect(() =>
			reconstructCryptoHftDataOrderBooks(request, [
				event({ side: "bid" }),
				event({ side: "ask", price: "101" }),
				event({
					event_type: "update",
					first_update_id: "12",
					final_update_id: "12",
					prev_final_update_id: "9",
					last_update_id: null,
				}),
			]),
		).toThrow("update_chain_gap");
	});

	test("anchors OKX replay on a complete snapshot after an irrelevant delta prefix", () => {
		const reconstructed = reconstructCryptoHftDataOrderBooks(
			okxRequest(),
			[
				okxEvent({
					event_type: "update",
					event_time: String(okxSnapshotTime - 1_000),
					final_update_id: "199",
					last_update_id: "198",
				}),
				okxEvent({ side: "bid", price: "100", quantity: "1" }),
				okxEvent({ side: "ask", price: "101", quantity: "2" }),
				okxEvent({
					event_type: "update",
					event_time: String(okxTarget),
					received_time: String(BigInt(okxTarget + 1_000) * 1_000_000n),
					final_update_id: "201",
					last_update_id: "200",
					side: "bid",
					price: "100",
					quantity: "3",
				}),
			],
			CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
		);

		expect(reconstructed).toHaveLength(1);
		expect(reconstructed[0]).toMatchObject({
			targetTimeMs: okxTarget,
			sourceTimeMs: okxTarget,
			sequence: "201",
			bids: [[100, 3]],
			asks: [[101, 2]],
		});
	});

	test("accepts an OKX maintenance reset only when prevSeqId links to the current state", () => {
		const reset = okxEvent({
			event_type: "update",
			event_time: String(okxTarget),
			received_time: String(BigInt(okxTarget + 1_000) * 1_000_000n),
			final_update_id: "5",
			last_update_id: "200",
			side: "bid",
			quantity: "4",
		});
		const rows = [
			okxEvent({ side: "bid" }),
			okxEvent({ side: "ask", price: "101" }),
			reset,
		];

		expect(
			reconstructCryptoHftDataOrderBooks(
				okxRequest(),
				rows,
				CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
			)[0]?.sequence,
		).toBe("5");
		expect(() =>
			reconstructCryptoHftDataOrderBooks(
				okxRequest(),
				[...rows.slice(0, 2), { ...reset, last_update_id: "199" }],
				CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
			),
		).toThrow("update_chain_gap");
	});

	test("rejects OKX rows when no snapshot anchors the earliest required clock", () => {
		expect(() =>
			reconstructCryptoHftDataOrderBooks(
				okxRequest(),
				[
					okxEvent({
						event_type: "update",
						final_update_id: "201",
						last_update_id: "200",
					}),
				],
				CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE,
			),
		).toThrow("update_before_snapshot");
	});

	test.each([
		{
			name: "invalid received clock",
			rows: [event({ received_time: "not-a-clock" })],
			reason: "schema_received_time_invalid",
		},
		{
			name: "stale prior-as-of sample",
			rows: [
				event({ event_time: String(target - 10_000), side: "bid" }),
				event({
					event_time: String(target - 10_000),
					side: "ask",
					price: "101",
				}),
			],
			reason: "required_clock_coverage_insufficient",
		},
		{
			name: "missing ask side",
			rows: [event({ side: "bid" })],
			reason: "book_side_missing",
		},
		{
			name: "crossed book",
			rows: [
				event({ side: "bid", price: "102" }),
				event({ side: "ask", price: "101" }),
			],
			reason: "book_crossed_or_locked",
		},
		{
			name: "sequence regression",
			rows: [
				event({ side: "bid" }),
				event({ side: "ask", price: "101" }),
				event({
					event_type: "update",
					first_update_id: "9",
					final_update_id: "9",
					prev_final_update_id: "10",
					last_update_id: null,
				}),
			],
			reason: "update_chain_gap",
		},
		{
			name: "snapshot sequence regression",
			rows: [
				event({ side: "bid" }),
				event({ side: "ask", price: "101" }),
				event({
					event_time: String(target - 1_000),
					last_update_id: "9",
					side: "bid",
				}),
				event({
					event_time: String(target - 1_000),
					last_update_id: "9",
					side: "ask",
					price: "101",
				}),
			],
			reason: "snapshot_sequence_regression",
		},
	] as const)("rejects $name", ({ rows, reason }) => {
		const request = validBackfillRequest({
			window: { startTimeMs: target - 20_000, endTimeMs: target + 1_000 },
			requiredClockTargetsMs: [target],
			maxPriorAsOfLagMs: 5_000,
		});
		expect(() => reconstructCryptoHftDataOrderBooks(request, rows)).toThrow(
			reason,
		);
	});
});
