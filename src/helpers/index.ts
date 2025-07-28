import fs from "fs";
import Joi from "joi";
import type { PolicyConfig } from "../types";
import { log } from "./logger";
import type { Metadata, ServerUnaryCall } from "@grpc/grpc-js";
import ccxt, { type Exchange } from "@usherlabs/ccxt";

export function authenticateRequest<T, E>(
	call: ServerUnaryCall<T, E>,
	whitelistIps: string[],
): boolean {
	const clientIp = call.getPeer().split(":")[0];
	if (!clientIp || !whitelistIps.includes(clientIp)) {
		log.warn(`Blocked access from unauthorized IP: ${clientIp || "unknown"}`);
		return false;
	}
	return true;
}

export function createBroker(cex: string, metadata: Metadata, useVerity: boolean, verityProverUrl: string): Exchange | null {
	const api_key = metadata.get("api-key");
	const api_secret = metadata.get("api-secret");

	const ExchangeClass = (ccxt.pro as Record<string, typeof Exchange>)[cex];

	metadata.remove("api-key");
	metadata.remove("api-secret");
	if (api_secret.length === 0 || api_key.length === 0 || !ExchangeClass) {
		return null;
	}
	const exchange = new ExchangeClass({
		apiKey: api_key[0]?.toString(),
		secret: api_secret[0]?.toString(),
		enableRateLimit: true,
		defaultType: "spot",
		useVerity: useVerity,
		verityProverUrl: verityProverUrl,
		timeout: 150 * 1000,
		options: {
			adjustForTimeDifference: true,
			recvWindow: 60000
		}
	});
	exchange.options.recvWindow = 60000;
	return exchange;
}

export function selectBroker(brokers: {
	primary: Exchange;
	secondaryBrokers: Exchange[];
} | undefined, metadata: Metadata): Exchange | null {
	if (!brokers) {
		return null
	} else {
		const use_secondary_key = metadata.get("use-secondary-key");
		if (!use_secondary_key || use_secondary_key.length === 0) {
			return brokers.primary
		}
		else if (use_secondary_key.length > 0) {
			const keyIndex = Number.isInteger(+(use_secondary_key[use_secondary_key.length - 1] ?? "0"))
			return brokers.secondaryBrokers[+keyIndex] ?? null
		}else{
			return null
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
