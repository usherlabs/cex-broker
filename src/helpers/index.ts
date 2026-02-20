import fs from "fs";
import Joi from "joi";
import type {
	PolicyConfig,
	BrokerCredentials,
	WithdrawRuleEntry,
} from "../types";
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
		async ({ url, config }) => {
			// { method, url, config, data, meta }
			let pending = client.get(url, config, { proofTimeout });
			if (redact) {
				pending = pending.redact(redact || "");
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
	const proofTimeout = rawTimeout ? parseInt(rawTimeout, 10) : 5 * 60 * 1000; // default 5 minutes
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
		typeof (credsOrMetadata as unknown as { get: unknown }).get ===
			"function" &&
		typeof (credsOrMetadata as unknown as { remove: unknown }).remove ===
			"function"
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

		const credsRecord = creds as Record<string, unknown>;
		const primaryApiKey =
			typeof credsRecord.apiKey === "string"
				? (credsRecord.apiKey as string)
				: undefined;
		const primaryApiSecret =
			typeof credsRecord.apiSecret === "string"
				? (credsRecord.apiSecret as string)
				: undefined;
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
		const secondaryKeysFromValidated = Array.isArray(credsRecord.secondaryKeys)
			? (credsRecord.secondaryKeys as BrokerCredentials[])
			: undefined;
		const secondaryKeysFromMap =
			credsRecord._secondaryMap && typeof credsRecord._secondaryMap === "object"
				? Object.values(
						credsRecord._secondaryMap as Record<
							number,
							Partial<BrokerCredentials>
						>,
					)
						.filter(
							(s): s is Required<BrokerCredentials> =>
								typeof s.apiKey === "string" && typeof s.apiSecret === "string",
						)
						.map((s) => ({ apiKey: s.apiKey, apiSecret: s.apiSecret }))
				: [];
		const secondaryKeys: BrokerCredentials[] =
			secondaryKeysFromValidated ?? secondaryKeysFromMap;

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

		// Joi schema for exchange-scoped withdraw rules
		const withdrawRuleEntrySchema = Joi.object({
			exchange: Joi.string().required(),
			network: Joi.string().required(),
			whitelist: Joi.array().items(Joi.string()).required(),
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
				.default([]),
		});

		// Full PolicyConfig schema
		const policyConfigSchema = Joi.object({
			withdraw: Joi.object({
				rule: Joi.array().items(withdrawRuleEntrySchema).min(1).required(),
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
			throw new Error(
				`Policy validation failed: ${error.details.map((d) => d.message).join("; ")}`,
			);
		}

		return normalizePolicyConfig(value as PolicyConfig);
	} catch (error) {
		console.error("Failed to load policy:", error);
		throw new Error("Policy configuration could not be loaded");
	}
}

export function normalizePolicyConfig(policy: PolicyConfig): PolicyConfig {
	return {
		...policy,
		withdraw: {
			...policy.withdraw,
			rule: policy.withdraw.rule.map((rule) => ({
				...rule,
				exchange: rule.exchange.trim().toUpperCase(),
				network: rule.network.trim().toUpperCase(),
				whitelist: rule.whitelist.map((address) => address.trim().toLowerCase()),
			})),
		},
		order: {
			...policy.order,
			rule: {
				...policy.order.rule,
				limits: policy.order.rule.limits ?? [],
			},
		},
	};
}

/**
 * Validates withdraw request against policy rules
 */
function getWithdrawRulePriority(
	rule: WithdrawRuleEntry,
	exchange: string,
	network: string,
): number {
	const exchangeMatch = rule.exchange === exchange || rule.exchange === "*";
	const networkMatch = rule.network === network || rule.network === "*";
	if (!exchangeMatch || !networkMatch) {
		return 0;
	}
	if (rule.exchange === exchange && rule.network === network) {
		return 4;
	}
	if (rule.exchange === exchange && rule.network === "*") {
		return 3;
	}
	if (rule.exchange === "*" && rule.network === network) {
		return 2;
	}
	return 1;
}

export function validateWithdraw(
	policy: PolicyConfig,
	exchange: string,
	network: string,
	recipientAddress: string,
	_amount: number,
	_ticker: string,
): { valid: boolean; error?: string } {
	const normalizedPolicy = normalizePolicyConfig(policy);
	const exchangeNorm = exchange.trim().toUpperCase();
	const networkNorm = network.trim().toUpperCase();
	const matchingRules = normalizedPolicy.withdraw.rule
		.map((rule) => ({
			rule,
			priority: getWithdrawRulePriority(rule, exchangeNorm, networkNorm),
		}))
		.filter((r) => r.priority > 0)
		.sort((a, b) => b.priority - a.priority);
	const withdrawRule = matchingRules[0]?.rule;

	if (!withdrawRule) {
		const allowedPairs = normalizedPolicy.withdraw.rule.map(
			(r) => `${r.exchange}:${r.network}`,
		);
		return {
			valid: false,
			error: `Network ${networkNorm} is not allowed for exchange ${exchangeNorm}. Allowed exchange/network pairs: ${allowedPairs.join(", ")}`,
		};
	}

	// Check if address is whitelisted
	if (!withdrawRule.whitelist.includes(recipientAddress.trim().toLowerCase())) {
		return {
			valid: false,
			error: `Address ${recipientAddress} is not whitelisted for withdrawals`,
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
	const brokerUpper = broker.trim().toUpperCase();
	const fromUpper = fromToken.trim().toUpperCase();
	const toUpper = toToken.trim().toUpperCase();

	const matchedPatterns = getMatchedMarketPatterns(
		orderRule.markets,
		brokerUpper,
		fromUpper,
		toUpper,
	);
	if (matchedPatterns.length === 0) {
		return {
			valid: false,
			error: `Market ${brokerUpper}:${fromUpper}/${toUpper} is not allowed. Allowed markets: ${orderRule.markets.join(", ")}`,
		};
	}

	const limits = orderRule.limits ?? [];
	if (limits.length === 0) {
		return { valid: true };
	}
	const limit = limits.find(
		(l) => l.from.toUpperCase() === fromUpper && l.to.toUpperCase() === toUpper,
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

function isMarketPatternMatch(
	pattern: string,
	broker: string,
	fromToken: string,
	toToken: string,
): boolean {
	const normalizedPattern = pattern.toUpperCase().trim();
	const directPair = `${fromToken}/${toToken}`;
	const reversePair = `${toToken}/${fromToken}`;

	if (normalizedPattern === "*") {
		return true;
	}

	const [exchangePattern, symbolPattern] = normalizedPattern.split(":");
	if (!exchangePattern || !symbolPattern) {
		return false;
	}

	const exchangeMatch = exchangePattern === "*" || exchangePattern === broker;
	if (!exchangeMatch) {
		return false;
	}

	if (symbolPattern === "*") {
		return true;
	}

	return symbolPattern === directPair || symbolPattern === reversePair;
}

function getMatchedMarketPatterns(
	markets: string[],
	broker: string,
	fromToken: string,
	toToken: string,
): string[] {
	return markets.filter((pattern) =>
		isMarketPatternMatch(pattern, broker, fromToken, toToken),
	);
}

type OrderExecutionResolution = {
	valid: boolean;
	error?: string;
	symbol?: string;
	side?: "buy" | "sell";
	amountBase?: number;
	limitsApplied?: boolean;
	matchedPatterns?: string[];
};

async function doesExchangeSupportSymbol(
	broker: Exchange,
	symbol: string,
): Promise<boolean> {
	try {
		await broker.loadMarkets();
		const marketMap = (
			broker as Exchange & { markets?: Record<string, unknown> }
		).markets;
		if (marketMap && typeof marketMap === "object" && symbol in marketMap) {
			return true;
		}
	} catch (error) {
		log.error(`Failed loading markets while resolving symbol ${symbol}`, error);
		return false;
	}

	try {
		broker.market(symbol);
		return true;
	} catch {
		return false;
	}
}

export async function resolveOrderExecution(
	policy: PolicyConfig,
	broker: Exchange,
	cex: string,
	fromToken: string,
	toToken: string,
	amount: number,
	price: number,
): Promise<OrderExecutionResolution> {
	const brokerUpper = cex.trim().toUpperCase();
	const fromUpper = fromToken.trim().toUpperCase();
	const toUpper = toToken.trim().toUpperCase();
	const matchedPatterns = getMatchedMarketPatterns(
		policy.order.rule.markets,
		brokerUpper,
		fromUpper,
		toUpper,
	);
	if (matchedPatterns.length === 0) {
		return {
			valid: false,
			error: `Market ${brokerUpper}:${fromUpper}/${toUpper} is not allowed. Allowed markets: ${policy.order.rule.markets.join(", ")}`,
			matchedPatterns,
		};
	}

	const directSymbol = `${fromUpper}/${toUpper}`;
	const reverseSymbol = `${toUpper}/${fromUpper}`;
	const hasDirectSymbol = await doesExchangeSupportSymbol(broker, directSymbol);
	const hasReverseSymbol = await doesExchangeSupportSymbol(
		broker,
		reverseSymbol,
	);
	if (!hasDirectSymbol && !hasReverseSymbol) {
		return {
			valid: false,
			error: `Exchange ${brokerUpper} does not support ${directSymbol} or ${reverseSymbol}`,
			matchedPatterns,
		};
	}

	const limits = policy.order.rule.limits ?? [];
	if (limits.length > 0) {
		const limit = limits.find(
			(l) =>
				l.from.toUpperCase() === fromUpper && l.to.toUpperCase() === toUpper,
		);
		if (!limit) {
			return {
				valid: false,
				error: `Conversion from ${fromUpper} to ${toUpper} is not allowed`,
				matchedPatterns,
				limitsApplied: true,
			};
		}

		if (amount < limit.min) {
			return {
				valid: false,
				error: `Amount ${amount} is below minimum ${limit.min} for ${fromUpper} to ${toUpper} conversion`,
				matchedPatterns,
				limitsApplied: true,
			};
		}
		if (amount > limit.max) {
			return {
				valid: false,
				error: `Amount ${amount} exceeds maximum ${limit.max} for ${fromUpper} to ${toUpper} conversion`,
				matchedPatterns,
				limitsApplied: true,
			};
		}
	}

	if (hasDirectSymbol) {
		return {
			valid: true,
			symbol: directSymbol,
			side: "sell",
			amountBase: amount,
			limitsApplied: limits.length > 0,
			matchedPatterns,
		};
	}

	if (!Number.isFinite(price) || price <= 0) {
		return {
			valid: false,
			error:
				"Price must be a finite number greater than 0 to compute base order amount",
			matchedPatterns,
			limitsApplied: limits.length > 0,
		};
	}

	return {
		valid: true,
		symbol: reverseSymbol,
		side: "buy",
		amountBase: amount / price,
		limitsApplied: limits.length > 0,
		matchedPatterns,
	};
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
