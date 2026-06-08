## 1. Contract And Parsing

- [x] 1.1 Add an order-book Call payload parser that accepts Maker's `method` field and the existing generic `functionName` field without weakening generic Call validation.
- [x] 1.2 Define supported order-book method constants for `fetch_order_book_capability`, `fetch_order_book_snapshot`, and `fetch_historical_order_book_snapshots`.
- [x] 1.3 Validate order-book Call inputs for `cex`, `symbol`, positive `depthLimit`, supported `constructionMode`, and historical `start`, `end`, and `cadence` fields before provider access.
- [x] 1.4 Route recognized order-book methods before the existing generic CCXT Call dispatch, and preserve existing generic Call behavior for all non-order-book methods.

## 2. Order-Book Provider Helpers

- [x] 2.1 Add a helper to resolve an exchange instance for public order-book market-data operations, including the chosen credential or public-instantiation behavior.
- [x] 2.2 Add a normalizer that converts provider order books into top-level `bids`, `asks`, `timestamp`, `receivedTimestamp`, `exchange`, `symbol`, `sequence`, and `depthLimit` fields.
- [x] 2.3 Ensure snapshot normalization requests or truncates each side to the requested depth limit and preserves provider sequence/update id aliases when available.
- [x] 2.4 Ensure normalized order-book payloads never include API keys, secrets, authorization headers, or secret-backed metadata.

## 3. Current Snapshot And Capability Methods

- [x] 3.1 Implement `fetch_order_book_snapshot` as a typed order-book Call handler backed by current provider order-book fetch behavior.
- [x] 3.2 Implement `fetch_order_book_capability` with conservative current, live, historical sampled top-N, and exact reconstruction capability fields.
- [x] 3.3 Ensure MEXC capability reports CCXT-backed provider identity for available broker current/live order-book support.
- [x] 3.4 Ensure Binance capability does not advertise native Hummingbot historical support unless a real adapter exists.
- [x] 3.5 Ensure `supportsExactL2Reconstruction` remains false until a validated reconstruction path exists.

## 4. Historical Snapshot Result Contract

- [x] 4.1 Implement `fetch_historical_order_book_snapshots` handler validation for window, cadence, depth, and construction mode.
- [x] 4.2 Return typed unsupported JSON with `unsupported = true` and `unsupportedReason = "historical_order_book_provider_unsupported"` when historical sampled top-N support is unavailable.
- [x] 4.3 Prevent historical requests from being satisfied by sampling the current live order book after the requested historical window.
- [x] 4.4 Return typed unsupported for exact L2 reconstruction unless snapshot-plus-delta continuity validation is implemented.

## 5. Live Stream Compatibility

- [x] 5.1 Enrich `Subscribe(ORDERBOOK)` frame `data` JSON with exchange, symbol, source timestamp, received timestamp, sequence/update id when available, and depth limit when configured.
- [x] 5.2 Preserve top-level `bids` and `asks` arrays in every successful order-book stream frame for old clients.
- [x] 5.3 Preserve existing omitted, invalid, and `NO_ACTION` subscription type compatibility that resolves to `ORDERBOOK`.
- [x] 5.4 Keep stream failures explicit through error frames or stream errors, never empty successful order-book frames.

## 6. Tests And Documentation

- [x] 6.1 Add unit tests for Maker `method` payload dispatch for capability, current snapshot, and historical snapshot calls.
- [x] 6.2 Add unit tests that generic non-order-book `Action.Call` behavior still works and dangerous generic method names remain rejected.
- [x] 6.3 Add unit tests for normalized snapshot fields, depth limit truncation, sequence alias preservation, and secret exclusion.
- [x] 6.4 Add unit tests for typed historical unsupported responses and exact reconstruction unsupported behavior.
- [x] 6.5 Add stream compatibility tests for old `bids`/`asks` consumers, enriched metadata, and omitted or `NO_ACTION` subscription type resolution.
- [x] 6.6 Update README and examples to document order-book Call methods, historical unsupported responses, capability fields, and the current `ORDERBOOK` enum/default behavior.

## 7. Validation

- [x] 7.1 Run `bun test`.
- [x] 7.2 Run `bun run check` or the repository's equivalent lint/type check command.
- [x] 7.3 Run `openspec validate cex-broker-order-book-depth-sourcing --strict`.
