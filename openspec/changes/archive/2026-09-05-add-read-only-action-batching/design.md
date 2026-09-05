## Context

The unary broker interface uses `ExecuteAction(ActionRequest) -> ActionResponse`; action payload values and `ActionResponse.result` are JSON strings carried by stable protobuf fields. Consumers currently issue separate RPCs and decode action-specific JSON themselves. `FetchFees` conflates public/default market fees with optional deposit/withdraw funding fees, `FetchCurrency` returns broad raw currency metadata, and market discovery is available only through generic `Action.Call`.

TASK-5 requires authenticated MEXC pair commission, source-bound market rules, and transfer-network facts while preserving pair-specific observations and avoiding historical claims. FIET Maker needs these independent facts with fewer gRPC round trips, but Maker source changes are not part of this repository delivery.

## Goals / Non-Goals

**Goals:**

- Provide generic batching for a registry-defined subset of read-only actions through the existing protobuf request and response messages.
- Make trading commission, market rules, and transfer-network evidence independently callable, versioned, timestamped, deterministic, and secret-free.
- Preserve child action result strings and proofs so consumers remain responsible for action-specific decoding.
- Support configured primary/secondary broker accounts and request-scoped credentials under one account context per batch.
- Produce durable Backlog evidence and a Maker-project `$handoff` after the broker implementation is verified.

**Non-Goals:**

- Batching writes, orders, transfers, deposits, withdrawals, configuration mutation, generic `Action.Call`, or nested batches.
- Reducing MEXC's required signed request count; `/api/v3/tradeFee` remains one request per symbol.
- Claiming that separately acquired facts form an atomic exchange snapshot.
- Historical fee schedules, effective intervals, fee-over-time reconstruction, Maker materializer changes, or Maker generated-client changes.
- Changing the protobuf fields of `ActionRequest` or `ActionResponse`.

## Decisions

### Use a registry-described `Batch` action, not a venue-specific facade

Add `FetchMarketRules = 16` and `Batch = 17` to the action enum. `Action.Batch` uses the ordinary `ExecuteAction` RPC. Its outer request supplies `cex` and gRPC metadata; `symbol` is empty and `payload.requests` is the string produced by `JSON.stringify` over the child array. Each child `action` is an integer protobuf enum value, `symbol` is a string, and `payload` is a string-valued map.

Each child has exactly:

```json
{
  "id": "fees-arb-usdc",
  "action": 12,
  "symbol": "ARB/USDC",
  "payload": {}
}
```

Children cannot supply `cex`, metadata, credentials, or account-routing fields. The batcher copies each child's `symbol` and `payload` unchanged into the child `ActionRequest`; it does not translate between them. Actions such as `GetPerpConfigState` therefore continue reading `payload.symbol`, while symbol-oriented actions continue reading `ActionRequest.symbol`. This makes batching a transport combinator over existing action boundaries rather than a second venue-evidence authority.

Alternative rejected: a dedicated `FetchVenueEvidence` facade. It would duplicate the external responsibilities of fee, market, and currency actions and encourage consumers to treat independently observed facts as one source.

Alternative rejected: a new typed protobuf batch response. The consumer owns child-result decoding, and the existing `ActionResponse.result` JSON boundary is intentionally retained.

### Put mutability and batchability on the action registry

Replace the handler-only registry value with a descriptor containing:

- handler;
- access classification (`read` or `write`);
- `batchable` boolean.

The batch validator reads this descriptor directly; there is no second array of action numbers. Initial batchable actions are `FetchBalances`, `FetchTicker`, `FetchCurrency`, `FetchAccountId`, `FetchFees`, `GetPerpConfigState`, and `FetchMarketRules`. `Action.Call`, `FetchDepositAddresses`, `GetOrderDetails`, all mutation actions, and `Batch` are not batchable in v1 even where an operation can sometimes be read-only, because their dispatch or side-effect semantics are broader than this contract.

A future action becomes batchable only by an explicit registry change with tests.

### Preserve child wire responses inside a versioned batch envelope

The outer `ActionResponse.result` is JSON:

```json
{
  "schemaVersion": "cex-broker-action-batch/v1",
  "responses": [
    {
      "id": "fees-arb-usdc",
      "action": 12,
      "symbol": "ARB/USDC",
      "response": {
        "result": "{\"schemaVersion\":\"cex-trading-fee-evidence/v1\"}",
        "proof": ""
      },
      "error": null
    }
  ]
}
```

Each entry contains exactly one of:

- `response: { result: string, proof: string }` and `error: null`; or
- `response: null` and `error: { code: string, grpcStatus: number, message: string }`.

The batch does not parse or merge successful child JSON. The outer proof is empty because no single proof attests to the complete batch; child proofs remain attached to their child responses. Before every child, the batcher starts empty child proof state and scopes or rebinds the Verity proof callback to that child. It snapshots the proof at child completion and prevents failed or proof-less children from inheriting a previous proof. Input order is response order.

Malformed batches, duplicate ids, prohibited actions, invalid child payloads, forbidden routing overrides, batches over 32 entries, and encoded `payload.requests` values over 256 KiB return outer gRPC `INVALID_ARGUMENT` before any provider call. Once the complete batch is structurally valid, the outer RPC returns gRPC `OK` even when one or more children fail at runtime; each failed entry carries the stable code, sanitized message, and the same gRPC status that the action would have returned when called directly. Runtime child failures do not stop later validated children.

V1 executes children sequentially through one selected authenticated broker instance, preserving deterministic order and existing CCXT rate limiting; it performs no automatic retries. Each requested pair causes exactly one account-commission source invocation. Market loading and currency acquisition may reuse the selected exchange instance's cache, but batching never represents multiple pair commissions as one provider request.

### Reuse the normal action pipeline without recursive transport handling

The batch handler builds child execution contexts that inherit the already authenticated outer broker, metadata-derived selector, Verity settings, and telemetry dependencies. Every child receives a child-local callback collector. Child success, validation rejection, and runtime error complete only that collector and MUST NOT invoke the outer wrapped callback, emit outer terminal telemetry, or complete the transport. After all validated children finish, the batch handler invokes the outer callback exactly once with the envelope.

Domain extraction remains in helpers. The batch handler owns only validation, ordered dispatch, child-local completion collection, result/error collection, and envelope serialization. `src/server.ts` remains registration/wiring only.

### Hard-cut `FetchFees` to account-scoped trading commission

`FetchFees` continues to accept one slash-delimited unified spot symbol but no longer accepts token-only symbols, `includeAllFees`, or `includeFundingFees`. It requires a spot market and a callable account-authoritative `fetchTradingFee` operation. `loadMarkets` is permitted only to resolve the unified symbol and market identity required by `fetchTradingFee`; market-level maker/taker fields and `broker.fees` never populate commission evidence. For MEXC, the existing `@usherlabs/ccxt` implementation signs `GET /api/v3/tradeFee` and returns unified maker/taker rates plus the nested provider information.

The result is `cex-trading-fee-evidence/v1` and includes:

- exchange and `spot` market type;
- canonical pair (`BASE-QUOTE`), CCXT unified symbol (`BASE/QUOTE`), and exchange-native source symbol sent to the provider (for example `ARBUSDC`);
- normalized account selector;
- credential source (`configured_pool` or `request_metadata`);
- broker observation timestamp;
- source method `ccxt.fetchTradingFee`;
- canonical decimal-string maker/taker rates with `decimal_fraction` units;
- exact decimal-string maker/taker basis points with `basis_points` units;
- digest algorithm and source-response digest.

Raw public/default fee values never authorize this evidence. Missing capability, authentication failure, unsupported market type, token-only symbol, absent maker/taker values, or invalid decimals fail closed. Account commission unavailability uses the stable `fee_unavailable:` prefix and unary gRPC `FAILED_PRECONDITION`; the same status is retained in a batch child error. Decimal conversion uses string-based decimal normalization and scaling rather than binary floating-point multiplication. No effective interval fields exist.

### Add `FetchMarketRules` as the typed market boundary

`FetchMarketRules` accepts one spot symbol and returns `cex-market-rule-evidence/v1`. It uses the selected authenticated broker even though market acquisition is public, loads markets, resolves only the requested market, verifies active spot identity, and reports canonical pair (`BASE-QUOTE`), CCXT unified symbol (`BASE/QUOTE`), exchange-native source symbol, base/quote assets, CCXT precision mode, price and amount increments, minimum amount, minimum notional, source method, observation timestamp, and source digest.

Required MEXC fields are active spot identity, `precision.price`, `precision.amount`, `limits.amount.min`, and `limits.cost.min`; maximum amount, price, and notional limits remain optional. Missing required fields fail with `venue_discovery_unavailable`; values from another pair or controller defaults are never substituted. Generic `Action.Call(fetchMarkets)` remains available but is not batchable and is not qualification evidence.

### Hard-cut `FetchCurrency` to one transfer-network fact

`FetchCurrency` keeps the asset in `ActionRequest.symbol` and adds one required `network` payload field. It uses the selected authenticated broker and returns `cex-transfer-network-evidence/v1` for only that target, using existing currency discovery and transfer-network alias resolution.

The result reports asset, operator alias, resolved broker/exchange network identifiers, deposit/withdraw availability, withdrawal fee, available withdrawal limits, source method, observation timestamp, digest algorithm, and source digest. It excludes the prior raw currency blob and rejects an omitted or unresolved network.

Transfer-network fees are inventory-movement costs. They are not account trading commission, realized fill commission, or Maker's DEX venue-fee revenue.

### Hash each source fact independently

Reuse the repository's canonical JSON serializer and SHA-256 implementation. Before hashing or serializing evidence, recursively reject or remove secret-bearing keys and configured secret values. Each evidence digest covers its action identity, exchange, requested key, account selector where relevant, source method, and the canonical source object used to derive the normalized fields.

Observation timestamps and batch metadata do not replace source digests. No aggregate batch digest grants authority over child facts.

### Deliver downstream continuity outside repository documentation

The CEX Broker PR does not add a Maker-specific document under `docs/`. During finalization:

1. append the final contracts, verification evidence, live-smoke status, revision/PR, and handoff path to Backlog TASK-5 through the Backlog interface;
2. use `$handoff` with `/home/azureuser/ao-repos/fiet-maker-develop` as the target workdir so the document lands under the Maker project key;
3. include batch decoding, action-specific decoder/model changes, canonical broker-contract and proto updates, fee-fixture materialization, release sequencing, and unresolved blockers;
4. include no credentials, raw signed requests, or secret-bearing logs.

The Backlog record is the durable delivery evidence; the handoff is cross-session navigation for the downstream Maker implementation.

## Risks / Trade-offs

- **Breaking JSON contracts for `FetchFees` and `FetchCurrency`** → Publish as an explicit hard cut, update broker-owned tests/docs together, identify known downstream consumers in the Maker handoff, and do not deploy the new broker version to those consumers before adoption.
- **A generic batch could accidentally execute writes** → Derive eligibility from registry metadata, prevalidate every child, prohibit `Call` and nested batches, and execute nothing when structural validation fails.
- **One gRPC request may be mistaken for one exchange request** → Retain per-child source method/timestamp/digest and document MEXC's one-symbol commission requests.
- **Partial runtime results could be mistaken for a qualified profile** → Preserve explicit per-child errors and require downstream qualification to prove every requested correlation id succeeded and decoded.
- **Sequential execution increases total batch latency** → Accept deterministic/rate-safe v1 behavior; rely on the existing gRPC deadline and add bounded concurrency only in a later measured change.
- **Request-scoped credentials have no configured account object** → Report the metadata-derived selector with credential source `request_metadata`; never expose credential identity or values.
- **Canonical hashes can drift if undefined or numeric formatting changes** → Normalize evidence values to explicit JSON-compatible forms and cover key ordering, decimal formatting, and source changes with golden tests.
- **Local handoff files are not repository artifacts** → Record the handoff path, broker revision, and essential adoption summary in TASK-5 so the authoritative work record remains usable if the local handoff is unavailable.

## Migration Plan

1. Record this approved plan in TASK-5, mark it In Progress, assign one implementation owner, and note the approved hard cuts and Maker-handoff boundary.
2. Introduce registry metadata and the batch schema/dispatcher with only existing safe read actions enabled; verify old unary dispatch remains unchanged.
3. Add `FetchMarketRules`, hard-cut `FetchFees` and `FetchCurrency`, remove obsolete funding flags and generic response writers/readers, and register all three as batchable.
4. Regenerate the protobuf descriptor and update broker-owned action documentation and fixtures without changing `ActionRequest` or `ActionResponse` fields.
5. Run unit, RPC, security/redaction, type, lint, build, and targeted live MEXC verification. Live evidence must query ARB-USDC and ARB-USDT independently and retain observed values without asserting an expected profile.
6. Publish the broker change but keep production consumers on the prior broker version until they adopt the new JSON contracts.
7. Finalize TASK-5 evidence and create the Maker-project `$handoff`; downstream Maker work updates its canonical contract, generated decoders, batch client, and materializer before coordinated deployment.
8. Roll back by deploying the previous broker release. Do not add compatibility response aliases or dual writers unless an operator separately approves an owner, bounded lifetime, and removal condition.

## Open Questions

None. The approved design uses registry-derived read-only batching, preserves the protobuf request/response message shapes, hard-cuts the three evidence boundaries, keeps child decoding consumer-owned, and delivers Maker adoption through Backlog evidence plus a project-scoped handoff.
