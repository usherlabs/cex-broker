import type { Exchange } from "@usherlabs/ccxt";
import fs from "fs";
import Joi from "joi";
import type {
	DepositRuleEntry,
	PolicyConfig,
	WithdrawRuleEntry,
} from "../types";
import { type BrokerAccount, requireDestinationEmail } from "./broker";
import { log } from "./logger";
import {
	type BrokerMarketType,
	findTradableSymbol,
	parseMarketPattern,
	parseMarketType,
} from "./market-type";
import { australiaQuestionnaireSchema } from "./travel-rule";

export { authenticateRequest } from "./auth";
export {
	applyCommonExchangeConfig,
	type BrokerAccount,
	BrokerAccountPreconditionError,
	type BrokerPoolEntry,
	createBroker,
	createBrokerPool,
	createPublicBroker,
	getCurrentBrokerSelector,
	resolveBrokerAccount,
	selectBroker,
	selectBrokerAccount,
} from "./broker";
export {
	australiaQuestionnaireSchema,
	registerBinanceTravelRuleWithdrawEndpoint,
	resolveTravelRuleDecision,
	type TravelRuleDecision,
	withdrawViaLocalEntity,
} from "./travel-rule";
export {
	buildHttpClientOverrideFromMetadata,
	createVerityHttpClientOverride,
	verityHttpClientOverridePredicate,
} from "./verity";

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

		// Travel-rule config: per-exchange opt-in flag plus static questionnaire
		// answers keyed by destination address, validated against the AU schema at
		// load time so a malformed questionnaire fails startup, not a live withdraw.
		const travelRuleEntrySchema = Joi.object({
			exchange: Joi.string().required(),
			enabled: Joi.boolean().required(),
			description: Joi.string().optional(),
			addresses: Joi.object()
				.pattern(
					Joi.string(),
					Joi.object({
						questionnaire: australiaQuestionnaireSchema.required(),
					}),
				)
				.required(),
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

			travelRule: Joi.object({
				rule: Joi.array().items(travelRuleEntrySchema).required(),
			}).optional(),
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
				network: normalizeBrokerNetworkId(rule.network),
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
					network: normalizeBrokerNetworkId(rule.network),
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

const BROKER_NETWORK_ALIASES: Record<string, string> = {
	ARB: "ARBITRUM",
	ARBITRUM: "ARBITRUM",
	ETH: "ETHEREUM",
	ERC20: "ETHEREUM",
	ETHEREUM: "ETHEREUM",
	BNB: "BNB",
	BSC: "BNB",
	BEP20: "BNB",
};

export function normalizeBrokerNetworkId(network: string): string {
	const normalized = network.trim().toUpperCase();
	return BROKER_NETWORK_ALIASES[normalized] ?? normalized;
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
	const networkNorm = normalizeBrokerNetworkId(network);
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
		const destEmail = requireDestinationEmail(dest, "sub-to-sub");
		return await exchange.sapiPostSubAccountTransferSubToSub({
			toEmail: destEmail,
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
		const destEmail = requireDestinationEmail(dest, "primary-to-sub");
		return await exchange.sapiPostSubAccountUniversalTransfer({
			fromAccountType: "SPOT",
			toAccountType: "SPOT",
			toEmail: destEmail,
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
	marketType: BrokerMarketType = "spot",
): boolean {
	const normalizedPattern = pattern.toUpperCase().trim();
	const directPair = `${fromToken}/${toToken}`;
	const reversePair = `${toToken}/${fromToken}`;

	if (normalizedPattern === "*") {
		return true;
	}

	const [exchangePattern, rawSymbolPattern] = normalizedPattern.split(":");
	if (!exchangePattern || !rawSymbolPattern) {
		return false;
	}

	const exchangeMatch = exchangePattern === "*" || exchangePattern === broker;
	if (!exchangeMatch) {
		return false;
	}

	const parsedPattern = parseMarketPattern(rawSymbolPattern);
	if (
		parsedPattern.requiredMarketType !== undefined &&
		parsedPattern.requiredMarketType !== marketType
	) {
		return false;
	}

	const symbolPattern = parsedPattern.symbolPattern.toUpperCase();
	if (symbolPattern === "*") {
		return true;
	}

	return (
		symbolPattern === directPair ||
		symbolPattern === reversePair ||
		symbolPattern === `${directPair}:${toToken}` ||
		symbolPattern === `${reversePair}:${fromToken}`
	);
}

function getMatchedMarketPatterns(
	markets: string[],
	broker: string,
	fromToken: string,
	toToken: string,
	marketType: BrokerMarketType = "spot",
): string[] {
	return markets.filter((pattern) =>
		isMarketPatternMatch(pattern, broker, fromToken, toToken, marketType),
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
	marketTypeInput?: unknown,
): Promise<OrderExecutionResolution> {
	const brokerUpper = cex.trim().toUpperCase();
	const fromUpper = fromToken.trim().toUpperCase();
	const toUpper = toToken.trim().toUpperCase();
	const marketType = parseMarketType(marketTypeInput);
	const matchedPatterns = getMatchedMarketPatterns(
		policy.order.rule.markets,
		brokerUpper,
		fromUpper,
		toUpper,
		marketType,
	);
	if (matchedPatterns.length === 0) {
		return {
			valid: false,
			error: `Market ${brokerUpper}:${fromUpper}/${toUpper} (${marketType}) is not allowed. Allowed markets: ${policy.order.rule.markets.join(", ")}`,
			matchedPatterns,
		};
	}

	const tradable = await findTradableSymbol(
		broker,
		fromUpper,
		toUpper,
		marketType,
	);
	if (!tradable) {
		return {
			valid: false,
			error: `Exchange ${brokerUpper} does not support ${fromUpper}/${toUpper} for marketType ${marketType}`,
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

	if (tradable.side === "sell") {
		return {
			valid: true,
			symbol: tradable.symbol,
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
		symbol: tradable.symbol,
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
	const networkNorm = normalizeBrokerNetworkId(network);
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
