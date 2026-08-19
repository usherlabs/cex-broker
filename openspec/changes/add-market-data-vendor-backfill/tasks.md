## 1. Contracts and package boundary

- [x] 1.1 Add versioned, secret-free request, result, provider-capability, capture-bundle, and promotion-receipt schemas with canonical identity helpers.
- [x] 1.2 Publish a server-independent `@usherlabs/cex-broker/market-data-vendor-backfill` package subpath and verify that importing it has no broker/server side effects.

## 2. Closed worker orchestration

- [x] 2.1 Implement the dependency-injected `runMarketDataVendorBackfill` state machine with validation-before-I/O, qualified-archive-first preflight, capability-before-credentials, and every closed result status.
- [x] 2.2 Add deterministic capture-bundle and forwarder-batch identities, bounded row/byte chunking, retry behavior, and secret-redacted diagnostics.
- [x] 2.3 Cover worker ordering, failure mapping, concurrency no-op, idempotency, chunking, and redaction with synthetic dependency tests.

## 3. CryptoHFTData adapter and reconstruction

- [x] 3.1 Add a conservative, data-driven CryptoHFTData capability registry that enables only proven exchange/market/symbol profiles and rejects MEXC, exact L2, `fill_gaps`, and unproven timestamp or sequence semantics.
- [x] 3.2 Implement bounded UTC-hour discovery, bearer-authenticated object acquisition, Zstd/Parquet decoding, object hashing, schema validation, and acquisition-budget enforcement without shelling out.
- [x] 3.3 Implement snapshot reset and ordered price-level update replay, zero-quantity deletion, sequence/timestamp validation, prior-as-of clock sampling, and shared canonical top-N row construction.
- [x] 3.4 Add synthetic, redistributable adapter fixtures and tests for valid reconstruction, all malformed clock/sequence/book cases, deterministic checksums, and every acquisition budget.

## 4. External provenance and forwarder admission

- [x] 4.1 Add a dedicated external-backfill provenance type and canonical row construction without opening normal broker deployment-source configuration beyond `broker_read` and `broker_write`.
- [x] 4.2 Add `market_data.cex_order_book_capture_promotions` to the archive-forwarder allowlist, limits, and strict request validation with passing-only, source-bound, hash-validated receipt admission.
- [x] 4.3 Test valid promotion insertion, malformed and mismatched rejection, deterministic retry, and unchanged admission behavior for existing tables.

## 5. Qualification, retention, and archive reading

- [x] 5.1 Extend the ClickHouse schema with the append-only promotion table and exact-scope replay-qualified level and depth-summary views while preserving existing physical and canonical views.
- [x] 5.2 Change order-book TTL expressions so broker-origin live retention remains active and historical `external_backfill` rows are exempt, with promotion evidence retained at least as long.
- [x] 5.3 Extract reusable qualification-aware archive-reader and semantic-digest logic, and update the retained reference exporter to reject unqualified external bundles while preserving promotion metadata.
- [x] 5.4 Prove the promotion commit boundary, scope joins, old historical retention, conflict handling, and qualified export against the pinned real ClickHouse E2E runtime.

## 6. FIET-1017 semantic promotion

- [x] 6.1 Implement candidate canonical key/checksum equivalence, prefix/suffix stability, seam/sequence, conflict, depth/construction, future-leakage, required-clock coverage, and canonical-export compatibility verification.
- [x] 6.2 Build and submit the stable passing promotion receipt last, then require a successful post-promotion qualified coverage query before returning `promoted`.
- [x] 6.3 Add synthetic conformance tests for successful promotion and every fail-closed verification branch, ensuring failed or partial candidates remain unqualified.

## 7. Architecture, evidence, and release boundary

- [x] 7.1 Document the bounded worker lifecycle, credential and ClickHouse authority boundaries, deterministic producer retry ownership, and CEX/Fiet TEE/Fiet Maker proof ownership.
- [x] 7.2 Add package-subpath type/build smoke tests and an opt-in hash-only real-provider conformance harness that never persists licensed vendor payloads or secrets.
- [x] 7.3 Validate the complete OpenSpec change and record the required downstream Fiet TEE wrapper/package pin and Maker independent post-promotion consumer proof as explicit release prerequisites.
