import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import CEXBroker, {
	Action,
	type ActionRequest,
	type ActionResponse,
	type BatchChildRequest,
	BatchChildRequestSchema,
	BatchPayloadSchema,
	type BatchResponseEnvelope,
	BatchResponseEnvelopeSchema,
	MAX_BATCH_CHILDREN,
	MAX_BATCH_REQUEST_BYTES,
	type MarketRuleEvidence,
	MarketRuleEvidenceSchema,
	type PolicyConfig,
	type TradingFeeEvidence,
	TradingFeeEvidenceSchema,
	type TransferNetworkEvidence,
	TransferNetworkEvidenceSchema,
} from "@usherlabs/cex-broker";
import descriptor from "@usherlabs/cex-broker/proto/node.descriptor";

const policy: PolicyConfig = {
	withdraw: { rule: [] }, deposit: {}, order: { rule: { markets: [], limits: [] } },
};
const broker = new CEXBroker({}, policy);
await broker.stop();
const children: BatchChildRequest[] = [
	{ id: "fees", action: Action.FetchFees, symbol: "ARB/USDC", payload: {} },
	{ id: "rules", action: Action.FetchMarketRules, symbol: "ARB/USDC", payload: {} },
	{ id: "network", action: Action.FetchCurrency, symbol: "USDC", payload: { network: "BSC" } },
];
const request: ActionRequest = {
	action: Action.Batch, cex: "mexc", symbol: "", payload: { requests: JSON.stringify(children) },
};
BatchPayloadSchema.parse(request.payload);
for (const child of children) BatchChildRequestSchema.parse(child);
// These assertions fail compilation if package declarations decay to any.
// @ts-expect-error Payload values are wire strings, not nested child arrays.
const invalidPayload: ActionRequest = { payload: { requests: children } };
// @ts-expect-error Unknown action names are not protobuf actions.
const invalidAction: ActionRequest = { action: "UnsupportedAction" };
// @ts-expect-error Child action uses the integer wire enum, not a name.
const invalidChild: BatchChildRequest = { ...children[0]!, action: "FetchFees" };
void [invalidPayload, invalidAction, invalidChild];
assert.equal(Action.FetchMarketRules, 16);
assert.equal(Action.Batch, 17);
assert.equal(MAX_BATCH_CHILDREN, 32);
assert.equal(MAX_BATCH_REQUEST_BYTES, 262144);
const messages = descriptor.nested.cex_broker.nested;
assert.deepEqual(messages.ActionRequest.fields, {
	action: { type: "Action", id: 1 }, payload: { keyType: "string", type: "string", id: 2 },
	cex: { type: "string", id: 3 }, symbol: { type: "string", id: 4 },
});
assert.deepEqual(messages.ActionResponse.fields, {
	result: { type: "string", id: 1 }, proof: { type: "string", id: 2 },
});
const wire: ActionResponse = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const envelope: BatchResponseEnvelope = BatchResponseEnvelopeSchema.parse(JSON.parse(wire.result!));
let fees = 0;
let rules = 0;
let networks = 0;
for (const entry of envelope.responses) {
	assert.equal(entry.error, null);
	assert(entry.response);
	const value: unknown = JSON.parse(entry.response.result);
	if (entry.action === Action.FetchFees) {
		const fee: TradingFeeEvidence = TradingFeeEvidenceSchema.parse(value);
		assert.equal(fee.rateUnit, "decimal_fraction");
		// @ts-expect-error Observed evidence grants no historical applicability.
		void fee.effectiveFrom;
		fees++;
	} else if (entry.action === Action.FetchMarketRules) {
		const rule: MarketRuleEvidence = MarketRuleEvidenceSchema.parse(value);
		assert.equal(rule.marketType, "spot");
		rules++;
	} else if (entry.action === Action.FetchCurrency) {
		const network: TransferNetworkEvidence = TransferNetworkEvidenceSchema.parse(value);
		assert.equal(network.asset, "USDC");
		networks++;
	}
}
assert(fees > 0 && rules > 0 && networks > 0);
console.log("Installed ESM + strict typed Batch/evidence consumer passed");
