import type { Exchange } from "ccxt";
import type { PolicyConfig } from "../../types";
import fs from "fs";
import Joi from "joi";
import { log } from "./logger";

// TODO: This is still arb functionality... literally this node is "Package A to be sent to Binance, Package B sent to Kucoin, Package C sent to Coinjar."
export async function buyAtOptimalPrice(
	exchange: Exchange,
	symbol: string,
	size: number,
) {
	// 1) fetch the order book
	const book = await exchange.fetchOrderBook(symbol, 500);
	const bids = book.bids;

	// 2) walk bids until cumulative >= size
	let remaining = size;
	let cumCost = 0;
	let fillPrice = 0;

	for (const [priceRaw, volumeRaw] of bids) {
		const price = Number(priceRaw);
		const volume = Number(volumeRaw);
		const take = Math.min(volume, remaining);
		cumCost += take * price;
		remaining -= take;

		if (remaining <= 0) {
			fillPrice = price;
			break;
		}
	}

	if (remaining > 0) {
		throw new Error(
			`Insufficient depth: only filled ${size - remaining} of ${size}`,
		);
	}

	const avgPrice = cumCost / size;
	log.info(
		`[${new Date().toISOString()}] ` +
			`Will buy ${size} ${symbol.split("/")[0]} at limit ${fillPrice.toFixed(6)} ` +
			`(VWAP ≃ ${avgPrice.toFixed(6)})`,
	);
	return { avgPrice, fillPrice, size, symbol };
}

/**
 * Fetches the order book, computes the worst‐case fill price on the ask side for `size`,
 * and submits a single limit‐sell at that price.
 */
// TODO: This is still arb functionality... literally this node is "Package A to be sent to Binance, Package B sent to Kucoin, Package C sent to Coinjar."
export async function sellAtOptimalPrice(
	exchange: Exchange,
	symbol: string,
	size: number,
) {
	// 1) fetch the order book
	const book = await exchange.fetchOrderBook(symbol);
	const asks = book.asks;

	// 2) walk asks until cumulative >= size
	let remaining = size;
	let cumProceeds = 0;
	let fillPrice = 0;

	for (const entry of asks) {
		const priceRaw = entry[0];
		const volumeRaw = entry[1];

		if (priceRaw === undefined || volumeRaw === undefined) {
			throw new Error("Orderbook entry had undefined price or volume");
		}

		const price = Number(priceRaw);
		const volume = Number(volumeRaw);

		const take = Math.min(volume, remaining);
		cumProceeds += take * price;
		remaining -= take;

		if (remaining <= 0) {
			fillPrice = price;
			break;
		}
	}

	if (remaining > 0) {
		throw new Error(
			`Insufficient depth: only sold ${size - remaining} of ${size}`,
		);
	}

	const avgPrice = cumProceeds / size;
	log.info(
		`[${new Date().toISOString()}] ` +
			`Will sell ${size} ${symbol.split("/")[0]} at limit ${fillPrice.toFixed(6)} ` +
			`(VWAP ≃ ${avgPrice.toFixed(6)})`,
	);

	return { avgPrice, fillPrice, size, symbol };
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
