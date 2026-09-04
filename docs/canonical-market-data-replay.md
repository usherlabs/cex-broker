# CEX live/hot market-data archive

This document is the operating contract for the final CEX Broker live/hot boundary. CEX owns current/live exchange acquisition and policy-neutral ClickHouse writes. Maker/FIET-1015 owns vendor-object cold reads, historical reconstruction, and policy materialization. FIET-907 may consume resulting evidence but owns no CEX sourcing or historical write path.

## Deployment identity

```env
CEX_BROKER_ARCHIVE_ENABLED=true
CEX_BROKER_ARCHIVE_SOURCE=broker_read
CEX_BROKER_DEPLOYMENT_ID=market-reader-eu-1
CEX_BROKER_CAPTURE_BUNDLE_ID=cex-live-eu-1
CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=production
CEX_BROKER_ARCHIVE_FORWARDER_URL=http://archive-forwarder:8090/archive
CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH=/var/lib/cex-broker/archive-loss.jsonl
CEX_BROKER_ORDERBOOK_ARCHIVE_DEPTH_LIMIT=25
CEX_BROKER_ORDERBOOK_MEASUREMENT_BANDS_BPS=10,25,50,100
ARCHIVE_FORWARDER_MARKET_SOURCE=broker_read
ARCHIVE_FORWARDER_MARKET_DEPLOYMENT_ID=market-reader-eu-1
```

`CEX_BROKER_ARCHIVE_SOURCE` is closed to `broker_read|broker_write`. The broker derives and stamps that deployment source; callers cannot introduce a market source through row data. Invalid archive-depth or measurement-band configuration fails startup rather than clamping or substituting a configured value.

## Four-feed collector

The independent collector keeps ORDERBOOK, TICKER, TRADES, and OHLCV subscriptions alive against a separately deployed full broker. It owns no credentials, archive identity, or ClickHouse connection. The broker resolves credentials and emits at most one archive decision for each accepted physical feed observation before subscriber fanout.

Current snapshot and `Subscribe(ORDERBOOK)` retain their public response shapes. Subscriber depth projection remains independent of archive depth.

## ORDERBOOK hot contract

Each accepted ORDERBOOK observation produces:

1. a capture-schema `1.0.0` raw row whose `raw_checksum` and `raw_capture_id` commit to the complete normalized observation;
2. no more than configured N schema-`1.0.0` level rows per side, retained for diagnostics only; and
3. one summary-schema `2.0.0` row calculated from the complete validated observation before slicing.

The raw row uses `payload_encoding = orderbook_metadata_only_v1`. Its canonical JSON contains exactly the closed capture-profile, cadence, requested-depth, archive-depth, observed-edge/count, exhaustion, retained-count, and measurement-band fields. It never contains bids, asks, provider bodies, nested levels, or a full-body fallback. The full-observation checksum is an ingestion-time commitment; the discarded observation cannot be reconstructed from ClickHouse raw JSON alone.

Summary v2 uses midpoint-relative boundaries and aligned bid/ask arrays. Each band status is:

- `exact` when the complete observed edge reaches the boundary or validated provider evidence proves that side exhausted;
- `censored` when the observation stops inside the boundary without proven exhaustion.

A short count does not prove exhaustion. There is no `unknown` row. Missing, one-sided, malformed, inconsistent, or incomplete-provenance observations are rejected and therefore unavailable through the supported view. Diagnostic levels never repair, replace, or upgrade a missing or censored summary.

The canonical downstream fixture is:

```text
test/fixtures/cex-order-book-depth-summary-v2-conformance/v1/fixture.json
test/fixtures/cex-order-book-depth-summary-v2-conformance/v1/SHA256SUMS
```

A downstream repository may copy and pin these bytes without depending on a CEX checkout, package, executable, or sidecar.

## Supported ClickHouse surfaces

- `market_data.cex_order_book_levels_canonical` and `_conflicts`: broker-source schema-v1 diagnostics.
- `market_data.cex_order_book_depth_summary_canonical` and `_conflicts`: broker-source, complete-provenance, schema-v2-only depth evidence.
- `market_data.cex_stream_events`: metadata-only ORDERBOOK raw rows and unchanged raw behavior for other feeds.

Physical rows remain append-only. Identical retries converge only in canonical views. A logical key with multiple normalized checksums remains visible in its conflict view and excluded from canonical output. Existing summary-v1 physical rows may age out under TTL, but no supported writer, reader, alias, decoder, view, or fallback consumes them.

Both order-book tables use the uniform 90-day hot TTL. CEX Broker exposes no vendor acquisition, promotion, qualification, archive-selection, replay-qualified view, preparation package, or canonical Parquet product.

## Legacy migration

`services/archive-forwarder/scripts/migrate-legacy-market-data-to-canonical.ts` may migrate retained legacy order-book snapshots into bounded schema-v1 level rows with honest incomplete provenance. It emits no summary of either version and cannot make a historical interval visible through the supported v2 summary view.

## Terminal deployed-schema retirement

Normal forwarder startup applies non-destructive schema creation/additive columns/views only. It never deletes historical rows, changes deployed TTLs destructively, drops obsolete objects, or removes columns.

After source rejection is deployed and all historical writers are stopped, an explicitly approved operator operation must:

1. run read-only inventory and export required audit evidence;
2. delete `external_backfill` rows and wait for ClickHouse mutations;
3. apply unconditional 90-day TTLs;
4. drop obsolete promotion, qualification, selection, cluster-identity, and replay-qualified objects;
5. drop vendor-only `capture_origin`; and
6. run the terminal absence verifier.

The SQL artifacts are under `schema/clickhouse/migrations/retire_cex_order_book_historical_{inventory,apply,verify}.sql`. The typed orchestration is `services/archive-forwarder/scripts/order-book-schema-retirement.ts`. Destructive execution requires a named approval and backup; it is not performed automatically by tests or startup.

## Conformance boundaries

- **Proof A:** CEX-local acquisition-profile/feed-coalescing regression.
- **Proof B:** Maker-owned policy-equivalence regression.
- **Proof C:** production-compatible shared-wire sidecar proving Layer12 current/live gRPC access, feed sharing with one archive decision per physical observation, durable `hb_runtime` HTTP 202/spool admission, and exact persistence in five strategy tables.
- **Summary parity:** independent summary-v2 fixture/query contract and real-ClickHouse typed projection.

Proof C uses deterministic controlled/local venue data through production handlers. It is not public-network smoke, Maker policy proof, hot-reader parity, retention proof, or production soak. Public-network market smoke is optional and non-gating.

## Cutover and failure handling

Use a maintenance window: quiesce market archive writes, apply non-destructive v2 columns/views, deploy the v2-only writer, validate one bounded controlled live capture and supported query, then resume. If a blocking v2 defect appears, stop ORDERBOOK archival and forward-fix or roll back the application without reactivating summary v1, historical admission, preparation commands, or compatibility views.
