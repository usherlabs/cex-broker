import type { Dict, Exchange } from "@usherlabs/ccxt";
import Joi from "joi";
import type {
	PolicyConfig,
	TravelRuleDepositConfig,
	TravelRuleDepositQuestionnaire,
	TravelRuleQuestionnaire,
} from "../types";

/**
 * Binance travel-rule ("local entity") withdrawal support.
 *
 * Some jurisdictions (Australia from 2026-07-01 under AUSTRAC) require Binance
 * withdrawals to carry beneficiary metadata. Binance enforces this by rejecting
 * the standard `POST /sapi/v1/capital/withdraw/apply` endpoint with error -4104
 * and only accepting `POST /sapi/v1/localentity/withdraw/apply`, which takes an
 * extra required `questionnaire` field (a JSON string of beneficiary answers).
 *
 * ccxt has no wrapper for the localentity endpoint, so we register it at runtime
 * via the exchange's own `defineRestApi` and call the generated implicit method.
 * The questionnaire answers are static per destination address and are validated
 * at policy-load time by {@link australiaQuestionnaireSchema}.
 */

// Australia questionnaire shape per Binance's travel-rule docs. Conditional
// requirements mirror the official spec:
//   - bnfType required only when sending to another beneficiary (isAddressOwner=2)
//   - individual name/location fields required only for bnfType=0 (individual)
//   - corporate fields required only for bnfType=1 (corporate/entity)
//   - vasp required only when sending to another VASP (sendTo=2)
//   - vaspName required only when the VASP is not in Binance's list (vasp="others")
// Inapplicable fields are forbidden so config mistakes fail fast at startup.
// `is` schemas are explicitly `.required()` so that an ABSENT referenced field
// does not match (an optional Joi schema treats `undefined` as valid, which would
// otherwise wrongly trigger the required branch when e.g. bnfType is omitted).
const isAnotherBeneficiary = Joi.number().valid(2).required();
const isIndividual = Joi.number().valid(0).required();
const isCorporate = Joi.number().valid(1).required();
const isSendToVasp = Joi.number().valid(2).required();
const isVaspOthers = Joi.string().valid("others").required();

/** `base`, made required when sibling `ref` matches `is`, and forbidden otherwise. */
function requiredWhen(
	base: Joi.Schema,
	ref: string,
	is: Joi.Schema,
): Joi.Schema {
	return base.when(ref, {
		is,
		// biome-ignore lint/suspicious/noThenProperty: Joi .when() options object, not a thenable
		then: Joi.required(),
		otherwise: Joi.forbidden(),
	});
}

export const australiaQuestionnaireSchema = Joi.object({
	isAddressOwner: Joi.number().valid(1, 2).required(),
	sendTo: Joi.number().valid(1, 2).required(),
	// Binance requires an affirmative declaration; a false value can never yield a
	// successful withdrawal, so reject it when the static config is loaded.
	declaration: Joi.boolean().valid(true).required(),
	bnfType: requiredWhen(
		Joi.number().valid(0, 1),
		"isAddressOwner",
		isAnotherBeneficiary,
	),
	bnfFirstName: requiredWhen(Joi.string(), "bnfType", isIndividual),
	bnfLastName: requiredWhen(Joi.string(), "bnfType", isIndividual),
	country: requiredWhen(Joi.string(), "bnfType", isIndividual),
	city: requiredWhen(Joi.string(), "bnfType", isIndividual),
	bnfCorpName: requiredWhen(Joi.string(), "bnfType", isCorporate),
	bnfCorpCountry: requiredWhen(Joi.string(), "bnfType", isCorporate),
	bnfCorpCity: requiredWhen(Joi.string(), "bnfType", isCorporate),
	vasp: requiredWhen(Joi.string(), "sendTo", isSendToVasp),
	vaspName: requiredWhen(Joi.string(), "vasp", isVaspOthers),
});

export type TravelRuleDecision =
	| { mode: "standard" }
	| { mode: "localentity"; questionnaire: TravelRuleQuestionnaire }
	| { mode: "denied"; error: string };

/**
 * Decides whether a withdrawal must use Binance's travel-rule endpoint.
 *
 * Travel rule is opt-in per exchange via the `enabled` flag, so a non-AU account
 * keeps using the standard endpoint. When enabled, the destination address must
 * have a configured questionnaire; if it does not we fail closed rather than fall
 * back to the standard endpoint (which would just reproduce the -4104 rejection).
 */
export function resolveTravelRuleDecision(
	policy: PolicyConfig,
	exchange: string,
	recipientAddress: string,
): TravelRuleDecision {
	const rules = policy.travelRule?.rule ?? [];
	const exchangeNorm = exchange.trim().toUpperCase();
	const entry = rules.find(
		(rule) => rule.exchange.trim().toUpperCase() === exchangeNorm,
	);
	if (!entry || !entry.enabled) {
		return { mode: "standard" };
	}

	const addressNorm = recipientAddress.trim().toLowerCase();
	const match = Object.entries(entry.addresses).find(
		([address]) => address.trim().toLowerCase() === addressNorm,
	);
	if (!match) {
		return {
			mode: "denied",
			error: `no travel-rule questionnaire configured for ${exchangeNorm} address ${recipientAddress}`,
		};
	}

	return { mode: "localentity", questionnaire: match[1].questionnaire };
}

/**
 * Registers Binance's `localentity/withdraw/apply` endpoint on the exchange
 * instance. No-op for non-Binance exchanges. Idempotent — ccxt just reassigns
 * the generated implicit method if called again.
 */
export function registerBinanceTravelRuleWithdrawEndpoint(
	exchange: Exchange,
): void {
	if (exchange.id !== "binance") {
		return;
	}
	// Same rate-limit weight as capital/withdraw/apply; the signing path is shared
	// by all sapi private POSTs, so no ccxt fork change is needed.
	exchange.defineRestApi(
		{ sapi: { post: { "localentity/withdraw/apply": 4.0002 } } },
		"request",
	);
}

// -----------------------------------------------------------------------------
// Deposit side: auto-clearing travel-rule-frozen deposits.
//
// The AUSTRAC travel rule also freezes INBOUND deposits: Binance credits the
// deposit but holds it in `getUserAsset.freeze` (invisible to free+locked
// balances) until a per-deposit questionnaire is answered via
// `PUT /sapi/v1/localentity/deposit/provide-info`. Unlike the withdraw leg the
// answer is keyed by the on-chain SENDER, not a static destination, so a deposit
// is only auto-declared when its sender is PROVEN (on-chain) to be one of our
// configured originator wallets. See travel-rule-deposit-reconciler.ts.
// -----------------------------------------------------------------------------

// Australia DEPOSIT questionnaire. Distinct shape from the withdraw schema
// (`depositOriginator`/`receiveFrom` vs `isAddressOwner`/`sendTo`). Restricted
// to the self-owned case (value 1) because that is the only case the reconciler
// can attest: it declares a deposit only after proving the sender is our own
// wallet. Declaring a third-party origin (value 2) would require beneficiary
// identity fields we do not carry, so reject it at policy-load rather than
// silently submit an incomplete questionnaire. Unknown keys are rejected by
// Joi's default so a copy-paste of the withdraw questionnaire fails fast.
export const australiaDepositQuestionnaireSchema = Joi.object({
	depositOriginator: Joi.number().valid(1).required(),
	receiveFrom: Joi.number().valid(1).required(),
	// Binance requires an affirmative declaration; false can never clear a deposit.
	declaration: Joi.boolean().valid(true).required(),
});

/**
 * Returns the enabled deposit travel-rule config for an exchange, or null when
 * the feature is absent or disabled. Gated solely by `deposits.enabled` (not the
 * entry's withdraw `enabled` flag): when null the reconciler does nothing for the
 * exchange, preserving exact pre-feature behavior.
 */
export function getEnabledTravelRuleDepositConfig(
	policy: PolicyConfig,
	exchange: string,
): TravelRuleDepositConfig | null {
	const rules = policy.travelRule?.rule ?? [];
	const exchangeNorm = exchange.trim().toUpperCase();
	const entry = rules.find(
		(rule) => rule.exchange.trim().toUpperCase() === exchangeNorm,
	);
	const deposits = entry?.deposits;
	if (!deposits || !deposits.enabled) {
		return null;
	}
	return deposits;
}

/**
 * Looks up the questionnaire for a PROVEN on-chain sender. Matching is
 * case-insensitive. Returns null when the sender is not a declared originator —
 * the reconciler must then leave the deposit frozen and surface an anomaly
 * rather than attest an origin it cannot prove is ours.
 */
export function resolveDepositOriginatorQuestionnaire(
	config: TravelRuleDepositConfig,
	senderAddress: string,
): TravelRuleDepositQuestionnaire | null {
	const senderNorm = senderAddress.trim().toLowerCase();
	const match = Object.entries(config.originators).find(
		([address]) => address.trim().toLowerCase() === senderNorm,
	);
	return match ? match[1].questionnaire : null;
}

/**
 * Registers Binance's localentity deposit endpoints used by the reconciler:
 * the two read endpoints (deposit history + questionnaire requirements) and the
 * provide-info write. No-op for non-Binance exchanges. Idempotent.
 *
 * `localentity/deposit/provide-info` must be signed with the questionnaire JSON
 * RAW (unencoded) — see the @usherlabs/ccxt patch (`binance.sign` rawencode
 * branch). Signing it url-encoded yields Binance error -1022. The two GETs carry
 * only simple params and sign fine either way.
 *
 * provide-info is a 600-weight UID-limited write (same class as
 * capital/withdraw/apply), so it carries ccxt-binance's `4.0002` cost encoding
 * (`.0002` = charge the UID limiter) rather than a naive `1`, which would
 * under-throttle the write and invite -1003 once attestation is active.
 */
export function registerBinanceTravelRuleDepositEndpoints(
	exchange: Exchange,
): void {
	if (exchange.id !== "binance") {
		return;
	}
	exchange.defineRestApi(
		{
			sapi: {
				get: {
					"localentity/deposit/history": 1,
					"localentity/questionnaire-requirements": 1,
				},
				put: { "localentity/deposit/provide-info": 4.0002 },
			},
		},
		"request",
	);
}

type LocalEntityWithdrawArgs = {
	code: string;
	amount: number;
	address: string;
	network: string;
	questionnaire: TravelRuleQuestionnaire;
	// Extra caller params (memo/tag, withdrawOrderId, etc.), forwarded to keep
	// parity with the standard withdraw path. The fixed fields below win on
	// collision so params can never override coin/amount/network/questionnaire.
	params?: Record<string, string | number>;
};

type BinanceLocalEntityWithdraw = {
	sapiPostLocalentityWithdrawApply?: (
		params: Record<string, unknown>,
	) => Promise<Dict>;
};

/**
 * Mirrors ccxt's `binance.withdraw` currency/network/precision handling, but
 * targets the travel-rule endpoint and attaches the questionnaire. ccxt's
 * `urlencode` applies `encodeURIComponent` to the value, satisfying Binance's
 * requirement that the questionnaire JSON be URL-encoded in the request body.
 */
export async function withdrawViaLocalEntity(
	broker: Exchange,
	args: LocalEntityWithdrawArgs,
) {
	const exchange = broker as Exchange & BinanceLocalEntityWithdraw;
	if (typeof exchange.sapiPostLocalentityWithdrawApply !== "function") {
		throw new Error(
			"binance_localentity_withdraw_unavailable: travel-rule withdraw endpoint is not registered on this exchange instance",
		);
	}

	broker.checkAddress(args.address);
	await broker.loadMarkets();
	const currency = broker.currency(args.code);

	const networks = broker.safeDict(broker.options, "networks", {});
	const networkUpper = args.network.trim().toUpperCase();
	const mappedNetwork = broker.safeString(networks, networkUpper, networkUpper);

	const request: Record<string, unknown> = {
		...args.params,
		coin: currency.id,
		address: args.address,
		amount: broker.currencyToPrecision(args.code, args.amount),
		network: mappedNetwork,
		questionnaire: JSON.stringify(args.questionnaire),
	};

	const response = await exchange.sapiPostLocalentityWithdrawApply(request);
	return broker.parseTransaction(response, currency);
}
