import { describe, expect, test } from "bun:test";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../src/proto-package-definition";

const service = CEX_BROKER_PACKAGE_DEFINITION["cex_broker.cex_service"];

describe("server proto descriptor loading", () => {
	test("uses the runtime proto-loader options for descriptor deserialization", () => {
		const actionRequestBuffer = service.ExecuteAction.requestSerialize({
			action: 13,
			cex: "binance",
			symbol: "USDT",
			payload: { amount: "1" },
		});

		expect(
			service.ExecuteAction.requestDeserialize(actionRequestBuffer),
		).toEqual({
			action: "InternalTransfer",
			cex: "binance",
			symbol: "USDT",
			payload: { amount: "1" },
		});

		const subscribeRequestBuffer = service.Subscribe.requestSerialize({
			cex: "kraken",
			symbol: "ETH/USDT",
		});

		expect(
			service.Subscribe.requestDeserialize(subscribeRequestBuffer),
		).toEqual({
			cex: "kraken",
			symbol: "ETH/USDT",
			type: "NO_ACTION",
			options: {},
		});

		const subscribeResponseBuffer = service.Subscribe.responseSerialize({
			data: "{}",
			timestamp: "123",
			symbol: "ETH/USDT",
			type: 1,
		});

		expect(
			service.Subscribe.responseDeserialize(subscribeResponseBuffer),
		).toEqual({
			data: "{}",
			timestamp: "123",
			symbol: "ETH/USDT",
			type: "ORDERBOOK",
		});
	});
});
