import ccxt, { type bybit, type binance } from "ccxt";
import { SupportedBroker } from "../types";
import type { ISupportedBroker } from "../types";
import config from "./index";

// Map each broker key to its specific CCXT class
type BrokerInstanceMap = {
	[SupportedBroker.BYBIT]: bybit;
	[SupportedBroker.BINANCE]: binance;
};

// Dynamic BrokerMap: each key maps to the correct broker type
export type BrokerMap = Partial<{
	[K in ISupportedBroker]: BrokerInstanceMap[K];
}>;

// Initialize brokers map
const brokers: BrokerMap = {};

// Conditionally initialize Bybit broker
if (config.brokers.includes(SupportedBroker.BYBIT as ISupportedBroker)) {
	const bybitBroker = new ccxt.bybit({
		apiKey: config.bybitApiKey,
		secret: config.bybitApiSecret,
		defaultType: "spot",
	});
	// Override Bybit API hostname
	bybitBroker.options = {
		...bybitBroker.options,
		hostname: "bytick.com",
	};
	brokers[SupportedBroker.BYBIT as ISupportedBroker] = bybitBroker;
}

// Conditionally initialize Binance broker
if (config.brokers.includes(SupportedBroker.BINANCE as ISupportedBroker)) {
	const binanceBroker = new ccxt.binance({
		apiKey: config.binanceApiKey,
		secret: config.binanceApiSecret,
		defaultType: "spot",
	});
	// Override Binance API hostname
	binanceBroker.options = {
		...binanceBroker.options,
		hostname: "binance.me",
	};
	brokers[SupportedBroker.BINANCE as ISupportedBroker] = binanceBroker;
}

export default brokers as Required<BrokerMap>;
