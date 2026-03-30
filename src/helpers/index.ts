import type { Metadata, ServerUnaryCall } from "@grpc/grpc-js";
import type {
	Exchange,
	HttpClientOverride,
	HttpOverridePredicate,
} from "@usherlabs/ccxt";
import ccxt from "@usherlabs/ccxt";
import { VerityClient } from "@usherlabs/verity-client";
import fs from "fs";
import Joi from "joi";
import type {
	BrokerAccountRole,
	BrokerCredentials,
	DepositRuleEntry,
	PolicyConfig,
	WithdrawRuleEntry,
} from "../types";
import { CCXT_METHODS_WITH_VERITY } from "./constants";
import { log } from "./logger";

export type BrokerAccount = {
	exchange: Exchange;
	label: "primary" | `secondary:${number}`;
	index?: number;
	role?: BrokerAccountRole;
	email?: string;
	subAccountId?: string;
	uid?: string;
};

export type BrokerPoolEntry = {
	primary: BrokerAccount;
	secondaryBrokers: BrokerAccount[];
};

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
		_secondaryMap?: Record<number, Partial<BrokerCredentials>>;
	}
>;

type ValidatedCredentialsMap = Record<
	string,
	BrokerCredentials & { secondaryKeys: BrokerCredentials[] }
>;

function createBrokerAccount(
	brokerName: string,
	label: BrokerAccount["label"],
	creds: BrokerCredentials,
	index?: number,
): BrokerAccount | null {
	const exchange = createBroker(brokerName, {
		apiKey: creds.apiKey,
		apiSecret: creds.apiSecret,
	});
	if (!exchange) {
		return null;
	}
	return {
		exchange,
		label,
		index,
		role: creds.role,
		email: creds.email,
		subAccountId: creds.subAccountId,
		uid: creds.uid,
	};
}

export function createBrokerPool(
	cfg: EnvConfigMap | ValidatedCredentialsMap,
): Record<string, BrokerPoolEntry> {
	const pool: Record<string, BrokerPoolEntry> = {};

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

		const primary = createBrokerAccount(brokerName, "primary", {
			apiKey: primaryApiKey,
			apiSecret: primaryApiSecret,
			role:
				typeof credsRecord.role === "string"
					? (credsRecord.role as BrokerAccountRole)
					: undefined,
			email:
				typeof credsRecord.email === "string"
					? (credsRecord.email as string)
					: undefined,
			subAccountId:
				typeof credsRecord.subAccountId === "string"
					? (credsRecord.subAccountId as string)
					: undefined,
			uid:
				typeof credsRecord.uid === "string"
					? (credsRecord.uid as string)
					: undefined,
		});
		if (!primary) {
			log.warn(`❌ Failed to create primary for "${brokerName}"`);
			continue;
		}

		const secondaryBrokers: BrokerAccount[] = [];
		const secondaryKeysFromValidated = Array.isArray(credsRecord.secondaryKeys)
			? (credsRecord.secondaryKeys as BrokerCredentials[])
			: undefined;
		const secondaryEntriesFromValidated = secondaryKeysFromValidated?.map(
			(sec, idx) => [idx + 1, sec] as const,
		);
		const secondaryEntriesFromMap =
			credsRecord._secondaryMap && typeof credsRecord._secondaryMap === "object"
				? Object.entries(
						credsRecord._secondaryMap as Record<
							number,
							Partial<BrokerCredentials>
						>,
					)
						.filter(
							([, sec]) =>
								typeof sec.apiKey === "string" &&
								typeof sec.apiSecret === "string",
						)
						.map(
							([rawIndex, sec]) =>
								[
									Number(rawIndex),
									{
										apiKey: sec.apiKey as string,
										apiSecret: sec.apiSecret as string,
										role: sec.role,
										email: sec.email,
										subAccountId: sec.subAccountId,
										uid: sec.uid,
									},
								] as const,
						)
				: [];
		const secondaryEntries =
			secondaryEntriesFromValidated ?? secondaryEntriesFromMap;

		secondaryEntries.forEach(([index, sec]) => {
			const secEx = createBrokerAccount(
				brokerName,
				`secondary:${index}`,
				sec,
				index,
			);
			if (secEx) secondaryBrokers[index - 1] = secEx;
			else
				log.warn(`⚠️ Failed to create secondary #${index} for "${brokerName}"`);
		});

		pool[brokerName] = { primary, secondaryBrokers };
		log.info(
			`✅ Loaded "${brokerName}" with ${secondaryBrokers.length} secondaries`,
		);
	}

	return pool;
}

export function selectBroker(
	brokers: BrokerPoolEntry | undefined,
	metadata: Metadata,
): Exchange | null {
	return selectBrokerAccount(brokers, metadata)?.exchange ?? null;
}

export function getCurrentBrokerSelector(metadata: Metadata): string {
	const use_secondary_key = metadata.get("use-secondary-key");
	if (!use_secondary_key || use_secondary_key.length === 0) {
		return "primary";
	}
	const rawIndex = use_secondary_key[use_secondary_key.length - 1]?.toString();
	const index = rawIndex ? Number.parseInt(rawIndex, 10) : Number.NaN;
	return Number.isInteger(index) && index > 0
		? `secondary:${index}`
		: "primary";
}

export function resolveBrokerAccount(
	brokers: BrokerPoolEntry | undefined,
	selector: string,
): BrokerAccount | null {
	if (!brokers) {
		return null;
	}
	if (selector === "primary") {
		return brokers.primary;
	}
	const match = selector.match(/^secondary:(\d+)$/);
	if (!match) {
		return null;
	}
	const index = Number.parseInt(match[1] ?? "", 10);
	return Number.isInteger(index) && index > 0
		? (brokers.secondaryBrokers[index - 1] ?? null)
		: null;
}

export function selectBrokerAccount(
	brokers: BrokerPoolEntry | undefined,
	metadata: Metadata,
): BrokerAccount | null {
	return resolveBrokerAccount(brokers, getCurrentBrokerSelector(metadata));
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
			coins: Joi.array().items(Joi.string()).optional(),
		});

		const depositRuleEntrySchema = Joi.object({
			exchange: Joi.string().required(),
			network: Joi.string().required(),
			coins: Joi.array().items(Joi.string()).optional(),
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

			deposit: Joi.object({
				rule: Joi.array().items(depositRuleEntrySchema).optional(),
			}).required(),

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
				whitelist: rule.whitelist.map((address) =>
					address.trim().toLowerCase(),
				),
				...(rule.coins && {
					coins: rule.coins.map((c) => c.trim().toUpperCase()),
				}),
			})),
		},
		deposit: {
			...policy.deposit,
			...(policy.deposit.rule && {
				rule: policy.deposit.rule.map((rule) => ({
					...rule,
					exchange: rule.exchange.trim().toUpperCase(),
					network: rule.network.trim().toUpperCase(),
					...(rule.coins && {
						coins: rule.coins.map((c) => c.trim().toUpperCase()),
					}),
				})),
			}),
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

function getDepositRulePriority(
	rule: DepositRuleEntry,
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
	ticker: string,
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

	// Check if coin is allowed by the matched rule
	const coins = withdrawRule.coins;
	if (coins && coins.length > 0 && !coins.includes("*")) {
		const tickerNorm = ticker.trim().toUpperCase();
		if (!coins.includes(tickerNorm)) {
			return {
				valid: false,
				error: `Token ${tickerNorm} is not allowed for withdrawals on ${exchangeNorm}:${networkNorm}. Allowed: [${coins.join(", ")}]`,
			};
		}
	}

	return { valid: true };
}

type BinanceImplicitMethods = {
	sapiPostSubAccountTransferSubToMaster?: (
		params: Record<string, unknown>,
	) => Promise<unknown>;
	sapiPostSubAccountTransferSubToSub?: (
		params: Record<string, unknown>,
	) => Promise<unknown>;
	sapiPostSubAccountUniversalTransfer?: (
		params: Record<string, unknown>,
	) => Promise<unknown>;
};

/**
 * Routes an internal transfer to the correct Binance SAPI endpoint
 * based on source and destination account types.
 */
export async function transferBinanceInternal(
	source: BrokerAccount,
	dest: BrokerAccount,
	code: string,
	amount: number,
) {
	const exchange = source.exchange as Exchange & BinanceImplicitMethods;
	await source.exchange.loadMarkets();
	const currency = source.exchange.currency(code);
	const asset = currency.id;
	const amountStr = source.exchange.currencyToPrecision(code, amount);

	const isSourceSecondary = source.label.startsWith("secondary:");
	const isDestPrimary = dest.label === "primary";
	const isDestSecondary = dest.label.startsWith("secondary:");
	const isSourcePrimary = source.label === "primary";

	if (isSourceSecondary && isDestPrimary) {
		if (typeof exchange.sapiPostSubAccountTransferSubToMaster !== "function") {
			throw new Error(
				"Binance sub→master transfer is unavailable in this CCXT build",
			);
		}
		return await exchange.sapiPostSubAccountTransferSubToMaster({
			asset,
			amount: amountStr,
		});
	}

	if (isSourceSecondary && isDestSecondary) {
		if (typeof exchange.sapiPostSubAccountTransferSubToSub !== "function") {
			throw new Error(
				"Binance sub→sub transfer is unavailable in this CCXT build",
			);
		}
		if (!dest.email) {
			throw new Error(
				`Destination account "${dest.label}" has no email configured (required for sub→sub transfers)`,
			);
		}
		return await exchange.sapiPostSubAccountTransferSubToSub({
			toEmail: dest.email,
			asset,
			amount: amountStr,
		});
	}

	if (isSourcePrimary && isDestSecondary) {
		if (typeof exchange.sapiPostSubAccountUniversalTransfer !== "function") {
			throw new Error(
				"Binance universal transfer is unavailable in this CCXT build",
			);
		}
		if (!dest.email) {
			throw new Error(
				`Destination account "${dest.label}" has no email configured (required for master→sub transfers)`,
			);
		}
		return await exchange.sapiPostSubAccountUniversalTransfer({
			fromAccountType: "SPOT",
			toAccountType: "SPOT",
			toEmail: dest.email,
			asset,
			amount: amountStr,
		});
	}

	throw new Error(
		`Unsupported transfer direction: ${source.label} → ${dest.label}`,
	);
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

export function validateDeposit(
	policy: PolicyConfig,
	exchange: string,
	network: string,
	ticker: string,
): { valid: boolean; error?: string } {
	const normalizedPolicy = normalizePolicyConfig(policy);

	if (
		!normalizedPolicy.deposit.rule ||
		normalizedPolicy.deposit.rule.length === 0
	) {
		return { valid: true };
	}

	const exchangeNorm = exchange.trim().toUpperCase();
	const networkNorm = network.trim().toUpperCase();
	const tickerNorm = ticker.trim().toUpperCase();

	const matchingRules = normalizedPolicy.deposit.rule
		.map((rule) => ({
			rule,
			priority: getDepositRulePriority(rule, exchangeNorm, networkNorm),
		}))
		.filter((r) => r.priority > 0)
		.sort((a, b) => b.priority - a.priority);

	const depositRule = matchingRules[0]?.rule;

	if (!depositRule) {
		return {
			valid: false,
			error: `Deposits not allowed for ${exchangeNorm}:${networkNorm}`,
		};
	}

	if (
		depositRule.coins &&
		depositRule.coins.length > 0 &&
		!depositRule.coins.includes("*")
	) {
		if (!depositRule.coins.includes(tickerNorm)) {
			return {
				valid: false,
				error: `Token ${tickerNorm} not allowed for deposit on ${exchangeNorm}:${networkNorm}. Allowed: [${depositRule.coins.join(", ")}]`,
			};
		}
	}

	return { valid: true };
}
