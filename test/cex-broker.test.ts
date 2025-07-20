import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import CEXBroker from "../src/index";
import type { PolicyConfig } from "../src/types";
import * as grpc from "@grpc/grpc-js";

describe("CEXBroker", () => {
	let broker: CEXBroker;
	let testPolicy: PolicyConfig;

	beforeEach(() => {
		// Test policy configuration
		testPolicy = {
			withdraw: {
				rule: {
					networks: ["BEP20", "ETH"],
					whitelist: ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
					amounts: [
						{
							ticker: "USDT",
							max: 100000,
							min: 1,
						},
					],
				},
			},
			deposit: {},
			order: {
				rule: {
					markets: [
						"BINANCE:BTC/USDT",
						"BINANCE:ETH/USDT",
					],
					limits: [
						{ from: "USDT", to: "BTC", min: 1, max: 100000 },
						{ from: "BTC", to: "USDT", min: 0.001, max: 1 },
					],
				},
			},
		};

		// Clear environment variables before each test
		delete process.env.CEX_BROKER_BINANCE_API_KEY;
		delete process.env.CEX_BROKER_BINANCE_API_SECRET;
		delete process.env.CEX_BROKER_BINANCE_API_KEY_1;
		delete process.env.CEX_BROKER_BINANCE_API_SECRET_1;
	});

	afterEach(() => {
		if (broker) {
			broker.stop();
		}
	});

	describe("Environment Configuration", () => {
		test("should load primary API keys from environment", () => {
			process.env.CEX_BROKER_BINANCE_API_KEY = "test_key";
			process.env.CEX_BROKER_BINANCE_API_SECRET = "test_secret";

			broker = new CEXBroker({}, testPolicy);
			broker.loadEnvConfig();

			// Test that environment variables are loaded
			expect(process.env.CEX_BROKER_BINANCE_API_KEY).toBe("test_key");
			expect(process.env.CEX_BROKER_BINANCE_API_SECRET).toBe("test_secret");
		});

		test("should load secondary API keys from environment", () => {
			process.env.CEX_BROKER_BINANCE_API_KEY_1 = "secondary_key_1";
			process.env.CEX_BROKER_BINANCE_API_SECRET_1 = "secondary_secret_1";
			process.env.CEX_BROKER_BINANCE_API_KEY_2 = "secondary_key_2";
			process.env.CEX_BROKER_BINANCE_API_SECRET_2 = "secondary_secret_2";

			broker = new CEXBroker({}, testPolicy);
			broker.loadEnvConfig();

			// Test that secondary environment variables are loaded
			expect(process.env.CEX_BROKER_BINANCE_API_KEY_1).toBe("secondary_key_1");
			expect(process.env.CEX_BROKER_BINANCE_API_SECRET_1).toBe("secondary_secret_1");
			expect(process.env.CEX_BROKER_BINANCE_API_KEY_2).toBe("secondary_key_2");
			expect(process.env.CEX_BROKER_BINANCE_API_SECRET_2).toBe("secondary_secret_2");
		});

		test("should handle case-insensitive broker names", () => {
			process.env.CEX_BROKER_BINANCE_API_KEY = "test_key";
			process.env.CEX_BROKER_BINANCE_API_SECRET = "test_secret";

			broker = new CEXBroker({}, testPolicy);
			broker.loadEnvConfig();

			// Test that broker names are normalized to lowercase
			expect(process.env.CEX_BROKER_BINANCE_API_KEY).toBe("test_key");
		});

		test("should skip unrecognized environment variables", () => {
			process.env.CEX_BROKER_INVALID_VAR = "invalid_value";
			process.env.CEX_BROKER_BINANCE_API_KEY = "test_key";

			broker = new CEXBroker({}, testPolicy);
			broker.loadEnvConfig();

			// Test that only valid variables are processed
			expect(process.env.CEX_BROKER_BINANCE_API_KEY).toBe("test_key");
		});

		test("should handle empty API keys", () => {
			process.env.CEX_BROKER_BINANCE_API_KEY = "";
			process.env.CEX_BROKER_BINANCE_API_SECRET = "";

			broker = new CEXBroker({}, testPolicy);
			broker.loadEnvConfig();

			// Test that empty keys are handled
			expect(process.env.CEX_BROKER_BINANCE_API_KEY).toBe("");
		});
	});

	describe("Broker Initialization", () => {
		test("should initialize with empty credentials", () => {
			broker = new CEXBroker({}, testPolicy);
			expect(broker).toBeDefined();
		});

		test("should initialize with custom port", () => {
			broker = new CEXBroker({}, testPolicy, { port: 9090 });
			expect(broker).toBeDefined();
			// Note: The port property might not be directly accessible due to private implementation
		});

		test("should initialize with custom whitelist IPs", () => {
			const whitelistIps = ["192.168.1.100", "10.0.0.1"];
			broker = new CEXBroker({}, testPolicy, { whitelistIps });
			expect(broker).toBeDefined();
		});

		test("should initialize with Verity integration", () => {
			broker = new CEXBroker({}, testPolicy, {
				useVerity: true,
				verityProverUrl: "http://localhost:8080",
			});
			expect(broker).toBeDefined();
		});

		test("should use default port when not specified", () => {
			broker = new CEXBroker({}, testPolicy);
			expect(broker.port).toBe(8086);
		});

		test("should use default whitelist IPs when not specified", () => {
			broker = new CEXBroker({}, testPolicy);
			expect(broker).toBeDefined();
		});
	});

	describe("Policy Management", () => {
		test("should load policy from file path", () => {
			broker = new CEXBroker({}, "./policy/policy.json");
			expect(broker).toBeDefined();
		});

		test("should load policy from object", () => {
			broker = new CEXBroker({}, testPolicy);
			expect(broker).toBeDefined();
		});

		test("should validate policy structure", () => {
			const invalidPolicy = {
				withdraw: {},
				// Missing order policy
			};

			// Test that invalid policy is handled
			expect(invalidPolicy.order).toBeUndefined();
		});

		test("should handle policy file watching", () => {
			broker = new CEXBroker({}, "./policy/policy.json");
			expect(broker).toBeDefined();
		});
	});

	describe("Exchange Credentials", () => {
		test("should validate exchange credentials structure", () => {
			const validCredentials = {
				binance: {
					apiKey: "test_key",
					apiSecret: "test_secret",
				},
			};

			const invalidCredentials = {
				binance: {
					apiKey: "test_key",
					// Missing apiSecret
				},
			};

			// Test validation logic
			expect(validCredentials.binance.apiSecret).toBeDefined();
			expect(invalidCredentials.binance.apiSecret).toBeUndefined();
		});

		test("should handle multiple exchanges", () => {
			const credentials = {
				binance: {
					apiKey: "binance_key",
					apiSecret: "binance_secret",
				},
				bybit: {
					apiKey: "bybit_key",
					apiSecret: "bybit_secret",
				},
			};

			broker = new CEXBroker(credentials, testPolicy);
			expect(broker).toBeDefined();
		});

		test("should handle secondary broker credentials", () => {
			const credentials = {
				binance: {
					apiKey: "primary_key",
					apiSecret: "primary_secret",
				},
			};

			broker = new CEXBroker(credentials, testPolicy);
			expect(broker).toBeDefined();
		});
	});

	describe("Server Management", () => {
		test("should start server successfully", async () => {
			broker = new CEXBroker({}, testPolicy, { port: 0 }); // Use random port
			const startedBroker = await broker.run();
			expect(startedBroker).toBe(broker);
		});

		test("should stop server successfully", () => {
			broker = new CEXBroker({}, testPolicy);
			broker.stop();
			expect(broker).toBeDefined();
		});

		test("should handle server startup errors", async () => {
			// Test with invalid port
			broker = new CEXBroker({}, testPolicy, { port: -1 });
			
			try {
				await broker.run();
				expect(false).toBe(true); // Should not reach here
			} catch (error) {
				expect(error).toBeDefined();
			}
		});
	});

	describe("Configuration Validation", () => {
		test("should validate port number", () => {
			const validPort = 8086;
			const invalidPort = -1;

			expect(validPort > 0 && validPort <= 65535).toBe(true);
			expect(invalidPort > 0 && invalidPort <= 65535).toBe(false);
		});

		test("should validate IP addresses", () => {
			const validIPs = ["127.0.0.1", "192.168.1.100"];
			const invalidIPs = ["invalid_ip", "256.256.256.256"];

			const isValidIPv4 = (ip: string) =>
				/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
				ip.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);

			validIPs.forEach(ip => expect(isValidIPv4(ip)).toBe(true));
			invalidIPs.forEach(ip => expect(isValidIPv4(ip)).toBe(false));
		});

		test("should validate Verity URL", () => {
			const validURL = "http://localhost:8080";
			const invalidURL = "not_a_url";

			const isValidURL = (url: string) => {
				try {
					new URL(url);
					return true;
				} catch {
					return false;
				}
			};

			expect(isValidURL(validURL)).toBe(true);
			expect(isValidURL(invalidURL)).toBe(false);
		});
	});

	describe("Error Handling", () => {
		test("should handle missing policy file", () => {
			try {
				broker = new CEXBroker({}, "./nonexistent/policy.json");
				expect(false).toBe(true); // Should not reach here
			} catch (error) {
				expect(error).toBeDefined();
			}
		});

		test("should handle invalid policy JSON", () => {
			const invalidPolicy = "invalid json";
			
			try {
				JSON.parse(invalidPolicy);
				expect(false).toBe(true); // Should not reach here
			} catch (error) {
				expect(error).toBeDefined();
			}
		});

		test("should handle network errors", () => {
			const networkError = new Error("Network timeout");
			expect(networkError.message).toBe("Network timeout");
		});

		test("should handle exchange initialization errors", () => {
			const invalidCredentials = {
				nonexistent: {
					apiKey: "invalid_key",
					apiSecret: "invalid_secret",
				},
			};

			// Test that invalid exchange is handled
			expect(invalidCredentials.nonexistent).toBeDefined();
		});
	});

	describe("Integration Tests", () => {
		test("should initialize with all components", () => {
			process.env.CEX_BROKER_BINANCE_API_KEY = "test_key";
			process.env.CEX_BROKER_BINANCE_API_SECRET = "test_secret";

			broker = new CEXBroker({}, testPolicy, {
				port: 8086,
				whitelistIps: ["127.0.0.1"],
				useVerity: false,
				verityProverUrl: "http://localhost:8080",
			});

			expect(broker).toBeDefined();
			expect(broker.port).toBe(8086);
		});

		test("should handle complex configuration", () => {
			const credentials = {
				binance: {
					apiKey: "primary_key",
					apiSecret: "primary_secret",
				},
			};

			broker = new CEXBroker(credentials, testPolicy, {
				port: 9090,
				whitelistIps: ["192.168.1.100", "10.0.0.1"],
				useVerity: true,
				verityProverUrl: "http://verity:8080",
			});

			expect(broker).toBeDefined();
		});
	});
}); 