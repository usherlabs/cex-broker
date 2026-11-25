import { describe, expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import ccxt from "ccxt";
import { getActionDescriptor } from "../src/handlers/execute-action/registry";
import { handleValidateAction } from "../src/handlers/execute-action/validate";
import { Action } from "../src/helpers/constants";
import { ActionValidationEnvelopeSchema } from "../src/schemas/action-evidence";
import type { PolicyConfig } from "../src/types";
import {
	createActionContext,
	createOfflineExchange,
	testPolicy,
	usdtCurrency,
	WHITELISTED_ADDRESS,
} from "./order-bounds-fixtures";

type Exchange = ReturnType<typeof createOfflineExchange>;

async function validate(
	request: { action: number; symbol: string; payload: Record<string, string> },
	options: { exchange?: Exchange; policy?: PolicyConfig; symbol?: string } = {},
) {
	const exchange = options.exchange ?? createOfflineExchange();
	const fixture = createActionContext(Action.ValidateAction, exchange.broker, {
		payload: { request: JSON.stringify(request) },
		symbol: options.symbol,
		policy: options.policy,
	});
	await handleValidateAction(fixture.ctx);
	const calls = exchange.calls;
	expect(fixture.getCallbackCount()).toBe(1);
	expect(calls.createOrder).toEqual([]);
	expect(calls.withdraw).toEqual([]);
	expect(calls.fetchDepositAddress).toEqual([]);
	const envelope =
		fixture.getError() === null
			? ActionValidationEnvelopeSchema.parse(fixture.getResult())
			: undefined;
	return { ...fixture, envelope };
}

function order(payload: Record<string, string>) {
	return {
		action: Action.CreateOrder,
		symbol: "BTC/USDT",
		payload: {
			orderType: "limit",
			fromToken: "BTC",
			toToken: "USDT",
			amount: "0.01",
			price: "30000",
			...payload,
		},
	};
}

function withdrawal(payload: Record<string, string> = {}) {
	return {
		action: Action.Withdraw,
		symbol: "USDT",
		payload: {
			recipientAddress: WHITELISTED_ADDRESS,
			amount: "25",
			chain: "BEP20",
			...payload,
		},
	};
}

function depositAddress(payload: Record<string, string> = {}) {
	return {
		action: Action.FetchDepositAddresses,
		symbol: "USDT",
		payload: { chain: "BEP20", ...payload },
	};
}

describe("ValidateAction registry entry", () => {
	test("is a read-only, non-batchable action", () => {
		const descriptor = getActionDescriptor(Action.ValidateAction);
		expect(descriptor?.access).toBe("read");
		expect(descriptor?.batchable).toBe(false);
	});
});

describe("ValidateAction CreateOrder", () => {
	test("returns the normalised immediate-or-cancel limit order without placing it", async () => {
		const { envelope } = await validate(
			order({
				amount: "0.01234567",
				price: "30000.123",
				timeInForce: "IOC",
				clientOrderId: "bound-1",
				params: JSON.stringify({ apiKey: "synthetic-credential" }),
			}),
		);
		expect(envelope).toMatchObject({
			schemaVersion: "cex-broker-action-validation/v1",
			exchange: "binance",
			action: "CreateOrder",
			symbol: "BTC/USDT",
			valid: true,
			reasons: [],
			checks: expect.arrayContaining([
				"market_limits",
				"market_precision",
				"market_time_in_force",
			]),
			normalized: {
				symbol: "BTC/USDT",
				marketType: "spot",
				side: "sell",
				orderType: "limit",
				amount: "0.0123",
				price: "30000.12",
				timeInForce: "IOC",
				postOnly: false,
				clientOrderId: "bound-1",
				adjustments: [
					{ field: "amount", requested: "0.01234567", normalized: "0.0123" },
					{ field: "price", requested: "30000.123", normalized: "30000.12" },
				],
			},
		});
	});

	test("truncates an exact amountBase string at the venue's precision", async () => {
		const { envelope } = await validate(
			order({ amountBase: "0.012345678901234567", price: "30000.00" }),
		);
		expect(envelope).toMatchObject({
			valid: true,
			normalized: {
				amount: "0.0123",
				price: "30000",
				adjustments: [
					{
						field: "amount",
						requested: "0.012345678901234567",
						normalized: "0.0123",
					},
				],
			},
		});
	});

	test("normalises a legacy quote-amount buy to its base quantity", async () => {
		const { envelope } = await validate(
			order({
				fromToken: "USDT",
				toToken: "BTC",
				amount: "100",
				price: "25000",
			}),
		);
		expect(envelope?.valid).toBe(true);
		expect(envelope).toMatchObject({
			normalized: { side: "buy", amount: "0.004", price: "25000" },
		});
	});

	test("reports a market order's notional against its reference price", async () => {
		const { envelope } = await validate(
			order({ orderType: "market", amount: "0.001", price: "3000" }),
		);
		expect(envelope).toMatchObject({
			valid: false,
			reasons: [
				{
					code: "market_limit_violated",
					field: "cost",
					message: "Notional at the reference price 3 is below the minimum 5",
				},
			],
		});
	});

	test("refuses an order below the market minimum amount and notional", async () => {
		const { envelope } = await validate(order({ amount: "0.0001" }));
		expect(envelope).toMatchObject({
			valid: false,
			reasons: [
				{
					code: "market_limit_violated",
					field: "amount",
					message: "Amount 0.0001 is below the minimum 0.001",
				},
				{
					code: "market_limit_violated",
					field: "cost",
					message: "Notional 3 is below the minimum 5",
				},
			],
		});
	});

	test("refuses an amount that truncates to zero at the venue's precision", async () => {
		const { envelope } = await validate(order({ amount: "0.00001" }));
		expect(envelope?.valid).toBe(false);
		expect(envelope?.reasons[0]).toMatchObject({
			code: "market_limit_violated",
			field: "amount",
		});
	});

	test("refuses a price above the market maximum", async () => {
		const { envelope } = await validate(order({ price: "2000000" }));
		expect(envelope).toMatchObject({
			valid: false,
			reasons: [
				{
					code: "market_limit_violated",
					field: "price",
					message: "Price 2000000 exceeds the maximum 1000000",
				},
			],
		});
	});

	test("applies broker policy", async () => {
		const { envelope } = await validate(order({}), {
			policy: testPolicy({
				order: {
					rule: {
						markets: ["BINANCE:BTC/USDT"],
						limits: [{ from: "BTC", to: "USDT", min: 0.1, max: 1 }],
					},
				},
			}),
		});
		expect(envelope).toMatchObject({
			valid: false,
			reasons: [
				{
					code: "policy_denied",
					message:
						"Amount 0.01 is below minimum 0.1 for BTC to USDT conversion",
				},
			],
		});
	});

	test("reports a pair the exchange does not list", async () => {
		const { envelope } = await validate(
			order({ fromToken: "ETH", toToken: "USDT" }),
			{
				policy: testPolicy({
					order: { rule: { markets: ["*"], limits: [] } },
				}),
			},
		);
		expect(envelope?.reasons).toEqual([
			{
				code: "market_unavailable",
				message:
					"Exchange BINANCE does not support ETH/USDT for marketType spot",
			},
		]);
	});

	test("reports an inactive market", async () => {
		const exchange = createOfflineExchange();
		(
			exchange.broker.markets["BTC/USDT"] as unknown as { active: boolean }
		).active = false;
		const { envelope } = await validate(order({}), { exchange });
		expect(envelope?.reasons).toEqual([
			{ code: "market_unavailable", message: "Market BTC/USDT is not active" },
		]);
	});

	test("reports a timeInForce the exchange does not advertise", async () => {
		const exchange = createOfflineExchange();
		(exchange.broker as unknown as { features: unknown }).features = {
			spot: { createOrder: { timeInForce: { GTC: true } } },
		};
		const { envelope } = await validate(order({ timeInForce: "FOK" }), {
			exchange,
		});
		expect(envelope?.reasons).toEqual([
			{
				code: "capability_unsupported",
				field: "timeInForce",
				message:
					"order_time_in_force_unsupported: Exchange does not advertise the requested time in force for this market type",
			},
		]);
	});

	test("reports an invalid timeInForce combination", async () => {
		const { envelope } = await validate(
			order({ orderType: "market", timeInForce: "IOC" }),
		);
		expect(envelope?.reasons).toEqual([
			{
				code: "time_in_force_invalid",
				field: "timeInForce",
				message:
					"order_time_in_force_invalid: timeInForce IOC requires a limit order",
			},
		]);
	});

	test("reports an invalid order payload", async () => {
		const { envelope } = await validate(order({ amount: "-1" }));
		expect(envelope?.reasons).toEqual([
			{
				code: "invalid_request",
				message: "ValidationError: amount: Too small: expected number to be >0",
			},
		]);
	});

	test("answers UNAVAILABLE when the venue's markets cannot be read", async () => {
		const exchange = createOfflineExchange("binance", {
			loadMarketsError: new ccxt.NetworkError("socket hang up"),
		});
		const { getError, envelope } = await validate(order({}), { exchange });
		expect(envelope).toBeUndefined();
		expect(getError()?.code).toBe(grpc.status.UNAVAILABLE);
		expect(getError()?.message).toStartWith("validation_unavailable:");
	});
});

describe("ValidateAction Withdraw", () => {
	test("returns the normalised withdrawal without withdrawing", async () => {
		const { envelope } = await validate(withdrawal());
		expect(envelope).toMatchObject({
			action: "Withdraw",
			symbol: "USDT",
			valid: true,
			normalized: {
				asset: "USDT",
				amount: "25",
				network: {
					operatorAlias: "BEP20",
					brokerNetworkId: "BNB",
					exchangeNetworkId: "BSC",
				},
				travelRuleMode: "standard",
				fee: "0.29",
			},
		});
	});

	test("collects policy and network-limit reasons together", async () => {
		const { envelope } = await validate(
			withdrawal({ recipientAddress: "0xnotlisted", amount: "5" }),
		);
		expect(envelope?.valid).toBe(false);
		expect(envelope?.reasons.map((reason) => reason.code)).toEqual([
			"policy_denied",
			"transfer_limit_violated",
		]);
		expect(envelope?.reasons[0]?.message).toStartWith(
			"policy_withdrawal_denied:",
		);
		expect(envelope?.reasons[1]?.message).toBe(
			"Withdrawal amount 5 is below the minimum 10",
		);
	});

	test("reports a network with withdrawals disabled", async () => {
		const { envelope } = await validate(withdrawal({ chain: "ETH" }));
		expect(envelope?.reasons).toEqual([
			{
				code: "network_unavailable",
				field: "chain",
				message: "Withdrawals of USDT on ETH are disabled",
			},
		]);
	});

	test("reports a network the exchange does not list", async () => {
		const { envelope } = await validate(withdrawal({ chain: "SOL" }));
		expect(envelope?.reasons).toEqual([
			{
				code: "network_unavailable",
				field: "chain",
				message:
					"network_alias_unresolved: USDT/SOL is not available in discovered transfer networks",
			},
		]);
	});

	test("reports a travel-rule destination without a questionnaire", async () => {
		const { envelope } = await validate(withdrawal(), {
			policy: testPolicy({
				travelRule: {
					rule: [{ exchange: "BINANCE", enabled: true, addresses: {} }],
				},
			} as Partial<PolicyConfig>),
		});
		expect(envelope?.reasons.map((reason) => reason.code)).toEqual([
			"travel_rule_denied",
		]);
	});

	test("reports an exchange that does not advertise withdraw", async () => {
		const exchange = createOfflineExchange();
		exchange.broker.has.withdraw = false;
		const { envelope } = await validate(withdrawal(), { exchange });
		expect(envelope?.reasons).toEqual([
			{
				code: "capability_unsupported",
				message: "binance does not advertise withdraw",
			},
		]);
	});
});

describe("ValidateAction FetchDepositAddresses", () => {
	test("returns the normalised deposit-address request without requesting it", async () => {
		const { envelope } = await validate(depositAddress());
		expect(envelope).toMatchObject({
			action: "FetchDepositAddresses",
			valid: true,
			normalized: {
				asset: "USDT",
				network: { brokerNetworkId: "BNB", exchangeNetworkId: "BSC" },
				method: "fetchDepositAddress",
			},
		});
	});

	test("refuses params that would select an unchecked deposit network", async () => {
		const { envelope } = await validate(
			depositAddress({
				params: JSON.stringify({
					network: "ETH",
					apiKey: "synthetic-credential",
				}),
			}),
		);
		expect(envelope?.valid).toBe(false);
		expect(envelope?.reasons).toContainEqual(
			expect.objectContaining({ code: "invalid_request", field: "params" }),
		);
		expect(JSON.stringify(envelope)).not.toContain("synthetic-credential");
	});

	test("reports a deposit network that is disabled", async () => {
		const { envelope } = await validate(depositAddress({ chain: "ETH" }));
		expect(envelope?.reasons).toEqual([
			{
				code: "network_unavailable",
				field: "chain",
				message: "Deposits of USDT on ETH are disabled",
			},
		]);
	});

	test("reports broker deposit policy", async () => {
		const currencies = usdtCurrency();
		const exchange = createOfflineExchange("binance", {
			currencies: { USDC: { ...currencies.USDT, id: "USDC", code: "USDC" } },
		});
		const { envelope } = await validate(
			{ ...depositAddress(), symbol: "USDC" },
			{ exchange },
		);
		expect(envelope?.reasons.map((reason) => reason.code)).toEqual([
			"policy_denied",
		]);
		expect(envelope?.reasons[0]?.message).toStartWith("policy_deposit_denied:");
	});

	test("reports an exchange without a deposit-address method", async () => {
		const exchange = createOfflineExchange();
		exchange.broker.has.fetchDepositAddress = false;
		exchange.broker.has.fetchDepositAddressesByNetwork = false;
		const { envelope } = await validate(depositAddress(), { exchange });
		expect(envelope?.reasons.map((reason) => reason.code)).toEqual([
			"capability_unsupported",
		]);
	});
});

describe("ValidateAction request shape", () => {
	test("refuses an action it cannot validate", async () => {
		const { getError } = await validate({
			action: Action.CancelOrder,
			symbol: "BTC/USDT",
			payload: { orderId: "1" },
		});
		expect(getError()).toEqual({
			code: grpc.status.INVALID_ARGUMENT,
			message:
				"ValidationError: CancelOrder cannot be validated; supported actions: CreateOrder, Withdraw, FetchDepositAddresses",
		});
	});

	test("refuses an outer symbol", async () => {
		const { getError } = await validate(order({}), { symbol: "BTC/USDT" });
		expect(getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(getError()?.message).toContain("symbol must be empty");
	});

	test("refuses a malformed request", async () => {
		const exchange = createOfflineExchange();
		const fixture = createActionContext(
			Action.ValidateAction,
			exchange.broker,
			{
				payload: { request: "{not json" },
			},
		);
		await handleValidateAction(fixture.ctx);
		expect(fixture.getError()?.code).toBe(grpc.status.INVALID_ARGUMENT);
		expect(fixture.getError()?.message).toStartWith("ValidationError: request");
	});
});
