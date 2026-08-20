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
- [x] 7.3 Validate the complete OpenSpec change and record the required downstream Fiet TEE wrapper/package pin and Maker independent post-promotion consumer proof as explicit production-dispatch prerequisites.

## 8. Live-provider isolated-archive verification gate

- [x] 8.1 Add failing contract tests for explicit opt-in and input validation, atomic secret-free pass/fail evidence, full promotion assertions, cleanup, and manual-only workflow configuration.
- [x] 8.2 Implement the bounded local smoke using a disposable ClickHouse Server 24.8, production schema, HTTP archive-forwarder, real CryptoHFTData adapter, qualified reader, worker core, canonical exporter, and idempotent second invocation.
- [x] 8.3 Add the local package command, protected manual GitHub workflow, and operator documentation without adding push, pull-request, schedule, Maker, or Fiet TEE responsibilities.
- [x] 8.4 Execute the gate locally with the API key read from Vault, retain only hash-safe evidence, run the complete regression suite, and strictly validate the reopened change.
  - Completed with the OKX Spot ARB-USDT positive control; see `implementation-evidence.md` for the hash-safe promotion, idempotency, archive, export, and regression evidence.

## 9. Unpublished v1 contract convergence

- [x] 9.1 Replace provisional wire types with strict snake_case Draft 2020-12 schemas and Ajv codecs for request, result, required clock, archive selection, and promotion receipt.
- [x] 9.2 Pin RFC 8785 JCS, add document identity helpers that omit only the owning digest, and publish schema/policy manifests with canonical digests.
- [x] 9.3 Add shared golden fixtures for every schema and for idempotency, policy, selection, promotion identity, full receipt, and RFC 8785 edge-vector hashes.
- [x] 9.4 Export codecs, manifests, JCS helpers, the runner, and a dependency factory from the server-independent package subpath.

## 10. Exact archive selection and outcome ownership

- [x] 10.1 Replace boolean coverage with exact coverage class, bundle intervals, requested intervals, precedence, qualification, receipt identities, and prior-as-of support anchors.
- [x] 10.2 Implement exact authoritative-window and fill-gaps resolution and persist/reload the original resolved selection and receipt for idempotent qualified reuse.
- [x] 10.3 Converge the closed CEX statuses and vendor subreasons, including resource-limit rejection, and remove worker-owned consumer insufficiency.
- [x] 10.4 Recompute and validate selection, promotion semantic, and full receipt identities on creation and archive reads, rejecting conflicting stored content.

## 11. Origin, qualification, cluster, and authorization

- [x] 11.1 Add deterministic `capture_origin` defaults and `vendor_historical_backfill_v1` source mode without changing existing capture-row or bundle checksum algorithms.
- [x] 11.2 Add append-only qualified/quarantined/revoked events and require the latest valid qualified state and final receipt in vendor replay views.
- [x] 11.3 Add the deployment-owned archive cluster identity singleton and require matching reader/forwarder/request environment and cluster before vendor or credential work.
- [x] 11.4 Validate production-forwarder authorization ID, scoped credential, expiry, environment, and cluster with fail-closed request/preflight mappings.

## 12. Package and release convergence

- [x] 12.1 Copy schemas, fixtures, and policies into the npm tarball, expose them through package exports, emit declarations, and prove no broker/server import side effects.
- [x] 12.2 Select the next unused package version no lower than `0.2.46`, build, inspect, and validate the package tarball.
- [x] 12.3 Rerun unit, forwarder, isolated ClickHouse, conformance, and protected live-provider gates using the final v1 contracts; retain only hash-safe evidence.
  - Final-v1 verification passed: 861 unit tests, 18 archive E2E tests, 14 ClickHouse Server 24.8 integration tests, protected one-object provider conformance, protected promotion/idempotency smoke, strict OpenSpec validation, and the `0.2.46` tarball audit. See `implementation-evidence.md` for hash-safe identities.
- [x] 12.4 Strictly validate and archive the implementation-complete CEX change, retaining downstream Fiet TEE and Maker conformance/pins as production-dispatch prerequisites.
  - Release sequencing was clarified during reconciliation: the CEX package must be publishable before downstream repositories can pin it. Fiet TEE executable conformance and Fiet Maker consumer proof therefore remain required before production dispatch is enabled, but do not block CEX package publication or OpenSpec archival.
