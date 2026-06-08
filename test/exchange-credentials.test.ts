import { describe, expect, test } from "bun:test";
import {
	buildCcxtConfig,
	isWalletBasedExchange,
} from "../src/helpers/exchange-credentials";
import { createBroker } from "../src/helpers/index";

const WALLET_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const PRIVATE_KEY =
	"0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

describe("exchange-credentials", () => {
	describe("isWalletBasedExchange", () => {
		test("returns true for wallet-authenticated exchanges", () => {
			expect(isWalletBasedExchange("hyperliquid")).toBe(true);
			expect(isWalletBasedExchange("vertex")).toBe(true);
			expect(isWalletBasedExchange("paradex")).toBe(true);
			expect(isWalletBasedExchange("derive")).toBe(true);
		});

		test("returns false for API-key exchanges", () => {
			expect(isWalletBasedExchange("binance")).toBe(false);
			expect(isWalletBasedExchange("mexc")).toBe(false);
		});

		test("returns false for dex exchanges that still use API keys", () => {
			expect(isWalletBasedExchange("woofipro")).toBe(false);
			expect(isWalletBasedExchange("modetrade")).toBe(false);
		});

		test("returns false for unknown exchanges", () => {
			expect(isWalletBasedExchange("not-a-real-exchange")).toBe(false);
		});
	});

	describe("buildCcxtConfig", () => {
		test("maps apiKey/apiSecret to walletAddress/privateKey for hyperliquid", () => {
			const config = buildCcxtConfig("hyperliquid", {
				apiKey: WALLET_ADDRESS,
				apiSecret: PRIVATE_KEY,
			});

			expect(config).toEqual({
				walletAddress: WALLET_ADDRESS,
				privateKey: PRIVATE_KEY,
			});
			expect(config).not.toHaveProperty("apiKey");
			expect(config).not.toHaveProperty("secret");
		});

		test("normalizes bare 64-char hex private keys with 0x prefix", () => {
			const barePrivateKey =
				"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
			const config = buildCcxtConfig("hyperliquid", {
				apiKey: WALLET_ADDRESS,
				apiSecret: barePrivateKey,
			});

			expect(config).toEqual({
				walletAddress: WALLET_ADDRESS,
				privateKey: `0x${barePrivateKey}`,
			});
		});

		test("keeps apiKey/secret mapping for centralized exchanges", () => {
			const config = buildCcxtConfig("binance", {
				apiKey: "binance-key",
				apiSecret: "binance-secret",
			});

			expect(config).toEqual({
				apiKey: "binance-key",
				secret: "binance-secret",
			});
		});

		test("returns null when credentials are missing", () => {
			expect(
				buildCcxtConfig("hyperliquid", { apiKey: "", apiSecret: PRIVATE_KEY }),
			).toBeNull();
			expect(
				buildCcxtConfig("binance", {
					apiKey: "binance-key",
					apiSecret: "",
				}),
			).toBeNull();
		});
	});

	describe("createBroker", () => {
		test("sets wallet credentials on hyperliquid exchange instances", () => {
			const broker = createBroker("hyperliquid", {
				apiKey: WALLET_ADDRESS,
				apiSecret: PRIVATE_KEY,
			});

			expect(broker).not.toBeNull();
			expect(broker?.walletAddress).toBe(WALLET_ADDRESS);
			expect(broker?.privateKey).toBe(PRIVATE_KEY);
			expect(broker?.apiKey).toBeUndefined();
			expect(broker?.secret).toBeUndefined();
		});

		test("sets api credentials on centralized exchange instances", () => {
			const broker = createBroker("binance", {
				apiKey: "binance-key",
				apiSecret: "binance-secret",
			});

			expect(broker).not.toBeNull();
			expect(broker?.apiKey).toBe("binance-key");
			expect(broker?.secret).toBe("binance-secret");
		});
	});
});
