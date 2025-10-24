import fs from "fs";
import Joi from "joi";
import type { PolicyConfig, BrokerCredentials } from "../types";
import { log } from "./logger";
import type { Metadata, ServerUnaryCall } from "@grpc/grpc-js";
import ccxt from "@usherlabs/ccxt";
import type {
	Exchange,
	HttpClientOverride,
	HttpOverridePredicate,
} from "@usherlabs/ccxt";
import { VerityClient } from "@usherlabs/verity-client";
import { CCXT_METHODS_WITH_VERITY } from "./constants";

export function authenticateRequest<T, E>(
	call: ServerUnaryCall<T, E>,
	whitelistIps: string[],
): boolean {
	const clientIp = call.getPeer().split(":")[0];
	if (whitelistIps.includes("*")) {
		return true;
	} else if (!clientIp || !whitelistIps.includes(clientIp)) {
		log.warn(`Blocked access from unauthorized IP: ${clientIp || "unknown"}`);
		return false;
	}
	return true;
}

export function createVerityHttpClientOverride(
	verityProverUrl: string,
	onProofCallback: (proof: string, notaryPubKey?: string) => void,
) {
	const client = new VerityClient({ proverUrl: verityProverUrl });
	return (redact: string, proofTimeout: number): HttpClientOverride =>
		async ({ method, url, config, data, meta }) => {
			let pending = client.get(url, config);
			if (redact) {
				pending = pending.redact(redact || ""); // ? Should Verity be configured for use on a per request basis always?
			}
			const response = await pending;
			if (response.proof) {
				onProofCallback(response.proof, response.notary_pub_key);
			}
			return response;
		};
}

export function applyCommonExchangeConfig(exchange: Exchange) {
	if (process.env.CEX_BROKER_SANDBOX_MODE === "true") {
		exchange.setSandboxMode(true);
	}
	// Ensure consistent defaults
	exchange.enableRateLimit = true;
	exchange.timeout = 150 * 1000;
	exchange.extendExchangeOptions({
		recvWindow: 60000,
		adjustForTimeDifference: true,
	});
}

export function buildHttpClientOverrideFromMetadata(
	metadata: Metadata,
	verityProverUrl: string,
	onProofCallback: (proof: string, notaryPubKey?: string) => void,
): HttpClientOverride {
	const redact = metadata.get("verity-t-redacted")?.[0]?.toString() || "";
	const rawTimeout = metadata.get("verity-proof-timeout")?.[0]?.toString();
	const proofTimeout = rawTimeout ? parseInt(rawTimeout, 10) : 60 * 1000;
	const factory = createVerityHttpClientOverride(
		verityProverUrl,
		onProofCallback,
	);
	return factory(redact, proofTimeout);
}

export const verityHttpClientOverridePredicate: HttpOverridePredicate = ({
	method,
	methodCalled,
}) => {
	return (
		["get", "post"].includes(method.toLowerCase()) &&
		CCXT_METHODS_WITH_VERITY.includes(methodCalled)
	);
};

export function createBroker(
	cex: string,
	credsOrMetadata: { apiKey: string; apiSecret: string } | Metadata,
): Exchange | null {
	let apiKey: string | undefined;
	let apiSecret: string | undefined;

	// Duck-typing check for gRPC Metadata (has get/remove functions)
	if (
		credsOrMetadata &&
		typeof (credsOrMetadata as unknown as { get: unknown }).get === "function" &&
		typeof (credsOrMetadata as unknown as { remove: unknown }).remove === "function"
	) {
		const metadata = credsOrMetadata as Metadata;
		apiKey = metadata.get("api-key")?.[0]?.toString();
		apiSecret = metadata.get("api-secret")?.[0]?.toString();
		metadata.remove("api-key");
		metadata.remove("api-secret");
	} else {
		const creds = credsOrMetadata as { apiKey: string; apiSecret: string };
		apiKey = creds.apiKey;
		apiSecret = creds.apiSecret;
	}

	const ExchangeClass = (ccxt.pro as Record<string, typeof Exchange>)[cex];
	if (!ExchangeClass || !apiKey || !apiSecret) {
		return null;
	}

	const exchange = new ExchangeClass({ apiKey, secret: apiSecret });
	applyCommonExchangeConfig(exchange);
	return exchange;
}

type EnvConfigMap = Record<
	string,
	Partial<BrokerCredentials> & {
		_secondaryMap?: Record<number, { apiKey?: string; apiSecret?: string }>;
	}
>;

type ValidatedCredentialsMap = Record<
	string,
	BrokerCredentials & { secondaryKeys: BrokerCredentials[] }
>;

export function createBrokerPool(
	cfg: EnvConfigMap | ValidatedCredentialsMap,
): Record<string, { primary: Exchange; secondaryBrokers: Exchange[] }> {
	const pool: Record<
		string,
		{ primary: Exchange; secondaryBrokers: Exchange[] }
	> = {};

	for (const [brokerName, creds] of Object.entries(cfg)) {
		const ExchangeClass = (ccxt.pro as Record<string, typeof Exchange>)[
			brokerName
		];
		if (!ExchangeClass) {
			log.warn(`❌ Invalid Broker: ${brokerName}`);
			continue;
		}

		const primaryApiKey = (creds as any).apiKey as string | undefined;
		const primaryApiSecret = (creds as any).apiSecret as string | undefined;
		if (!primaryApiKey || !primaryApiSecret) {
			log.warn(`❌ Missing API_KEY and/or API_SECRET for "${brokerName}"`);
			continue;
		}

		const primary = createBroker(brokerName, {
			apiKey: primaryApiKey,
			apiSecret: primaryApiSecret,
		});
		if (!primary) {
			log.warn(`❌ Failed to create primary for "${brokerName}"`);
			continue;
		}

		const secondaryBrokers: Exchange[] = [];
		const secondaryKeys: BrokerCredentials[] =
			(creds as any).secondaryKeys ??
			Object.values((creds as any)._secondaryMap ?? {})
				.filter((s: any) => s?.apiKey && s?.apiSecret)
				.map((s: any) => ({
					apiKey: s.apiKey as string,
					apiSecret: s.apiSecret as string,
				}));

		secondaryKeys.forEach((sec, idx) => {
			const secEx = createBroker(brokerName, {
				apiKey: sec.apiKey,
				apiSecret: sec.apiSecret,
			});
			if (secEx) secondaryBrokers[idx] = secEx;
			else log.warn(`⚠️ Failed to create secondary #${idx} for "${brokerName}"`);
		});

		pool[brokerName] = { primary, secondaryBrokers };
		log.info(
			`✅ Loaded "${brokerName}" with ${secondaryBrokers.length} secondaries`,
		);
	}

	return pool;
}

export function selectBroker(
	brokers:
		| {
				primary: Exchange;
				secondaryBrokers: Exchange[];
		  }
		| undefined,
	metadata: Metadata,
): Exchange | null {
	if (!brokers) {
		return null;
	} else {
		const use_secondary_key = metadata.get("use-secondary-key");
		if (!use_secondary_key || use_secondary_key.length === 0) {
			return brokers.primary;
		} else if (use_secondary_key.length > 0) {
			const keyIndex = Number.isInteger(
				+(use_secondary_key[use_secondary_key.length - 1] ?? "0"),
			);
			return brokers.secondaryBrokers[+keyIndex] ?? null;
		} else {
			return null;
		}
	}
}

/**
 * Loads and validates policy configuration
 */
export function loadPolicy(policyPath: string): PolicyConfig {
	try {
		const policyData = fs.readFileSync(policyPath, "utf8");

		// Joi schema for WithdrawRule
		const withdrawRuleSchema = Joi.object({
			networks: Joi.array().items(Joi.string()).required(),
			whitelist: Joi.array().items(Joi.string()).required(),
			amounts: Joi.array()
				.items(
					Joi.object({
						ticker: Joi.string().required(),
						max: Joi.number().required(),
						min: Joi.number().required(),
					}),
				)
				.required(),
		});

		// Joi schema for OrderRule
		const orderRuleSchema = Joi.object({
			markets: Joi.array().items(Joi.string()).required(),
			limits: Joi.array()
				.items(
					Joi.object({
						from: Joi.string().required(),
						to: Joi.string().required(),
						min: Joi.number().required(),
						max: Joi.number().required(),
					}),
				)
				.required(),
		});

		// Full PolicyConfig schema
		const policyConfigSchema = Joi.object({
			withdraw: Joi.object({
				rule: withdrawRuleSchema.required(),
			}).required(),

			deposit: Joi.object()
				.pattern(Joi.string(), Joi.valid(null)) // Record<string, null>
				.required(),

			order: Joi.object({
				rule: orderRuleSchema.required(),
			}).required(),
		});

		const { error, value } = policyConfigSchema.validate(
			JSON.parse(policyData),
		);

		if (error) {
			console.error("Validation failed:", error.details);
		}

		return value as PolicyConfig;
	} catch (error) {
		console.error("Failed to load policy:", error);
		throw new Error("Policy configuration could not be loaded");
	}
}

/**
 * Validates withdraw request against policy rules
 */
// TODO: Nice work on the policy engine, however, we'll need incorporate a mapping between how the CEX Broker recognises networks, and how different CEXs recognise networks - eg. Binance might have "BSC", but another chain will have BNB"
export function validateWithdraw(
	policy: PolicyConfig,
	network: string,
	recipientAddress: string,
	amount: number,
	ticker: string,
): { valid: boolean; error?: string } {
	const withdrawRule = policy.withdraw.rule;

	// Check if network is allowed
	if (!withdrawRule.networks.includes(network)) {
		return {
			valid: false,
			error: `Network ${network} is not allowed. Allowed networks: ${withdrawRule.networks.join(", ")}`,
		};
	}

	// Check if address is whitelisted
	if (!withdrawRule.whitelist.includes(recipientAddress.toLowerCase())) {
		return {
			valid: false,
			error: `Address ${recipientAddress} is not whitelisted for withdrawals`,
		};
	}

	// Check amount limits
	const amountRule = withdrawRule.amounts.find((a) => a.ticker === ticker);

	if (!amountRule) {
		return {
			valid: false,
			error: `Ticker ${ticker} is not allowed. Supported tickers: ${withdrawRule.amounts.map((a) => a.ticker).join(", ")}`,
		};
	}

	if (amount < amountRule.min) {
		return {
			valid: false,
			error: `Amount ${amount} is below minimum ${amountRule.min}`,
		};
	}

	if (amount > amountRule.max) {
		return {
			valid: false,
			error: `Amount ${amount} exceeds maximum ${amountRule.max}`,
		};
	}

	return { valid: true };
}

/**
 * Validates order request against policy rules
 */
export function validateOrder(
	policy: PolicyConfig,
	fromToken: string,
	toToken: string,
	amount: number,
	broker: string,
): { valid: boolean; error?: string } {
	const orderRule = policy.order.rule;

	// Check if market is allowed
	const marketKeys = [
		`${broker.toUpperCase()}:${toToken}/${fromToken}`,
		`${broker.toUpperCase()}:${fromToken}/${toToken}`,
	];
	if (
		!(
			orderRule.markets.includes(marketKeys[0] ?? "") ||
			orderRule.markets.includes(marketKeys[1] ?? "")
		)
	) {
		return {
			valid: false,
			error: `Market ${marketKeys} is not allowed. Allowed markets: ${orderRule.markets.join(", ")}`,
		};
	}

	// Check conversion limits
	const limit = orderRule.limits.find(
		(l) => l.from === fromToken && l.to === toToken,
	);

	if (!limit) {
		return {
			valid: false,
			error: `Conversion from ${fromToken} to ${toToken} is not allowed`,
		};
	}

	if (amount < limit.min) {
		return {
			valid: false,
			error: `Amount ${amount} is below minimum ${limit.min} for ${fromToken} to ${toToken} conversion`,
		};
	}

	if (amount > limit.max) {
		return {
			valid: false,
			error: `Amount ${amount} exceeds maximum ${limit.max} for ${fromToken} to ${toToken} conversion`,
		};
	}

	return { valid: true };
}

/**
 * Validates deposit request (currently empty but can be extended)
 */
export function validateDeposit(
	_policy: PolicyConfig,
	_chain: string,
	_amount: number,
): { valid: boolean; error?: string } {
	// Currently deposit policy is empty, so all deposits are allowed
	// This can be extended when deposit rules are added to the policy
	return { valid: true };
}
