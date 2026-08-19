## Context

CEX Broker already owns canonical market-data capture fields, deterministic
JSON/checksum rules, append-only order-book physical tables, checksum-consistent
canonical views, an HTTP archive-forwarder, and a retained ClickHouse-to-Parquet
reference exporter. Those pieces assume broker-origin live capture. They do not
provide a bounded vendor importer, distinguish a complete promoted external
bundle from partially inserted rows, or preserve historical data older than the
live 90-day source-time TTL.

Fiet Maker's `emulated-backtest-position-policy-authority` change defines the
consumer boundary: Maker preflights ClickHouse, invokes a pinned local
`market-data-vendor-backfill` product only on a typed coverage miss, waits for a
promotion result, then independently queries ClickHouse and materializes its
final artifacts. Fiet TEE is the executable and secure-secret boundary. CEX
Broker remains the owner of vendor adapters, normalization, forwarder
submission, archive qualification, and the FIET-1017 promotion receipt.

The initial provider publishes hourly Zstd-compressed Parquet objects containing
normalized L2 snapshot and price-level update records. Its current documented
exchange set does not include MEXC, and its standard licence permits internal
research rather than redistribution. The implementation therefore needs a
truthful capability matrix and synthetic public fixtures.

## Goals / Non-Goals

**Goals:**

- Publish a server-independent, dependency-injected backfill core API and
  versioned request/result/receipt contracts.
- Support an initial bounded CryptoHFTData sampled top-N ORDERBOOK path for
  explicitly proven exchange/market/symbol profiles.
- Reuse the existing CEX capture/checksum contract rather than create a second
  canonical row format.
- Submit through the archive-forwarder with deterministic retry identities and
  never give the worker direct ClickHouse write credentials.
- Make a passing promotion row the final append-only commit that grants
  external-backfill rows replay-qualified visibility.
- Prove FIET-1017 semantics and retain a clean binding for Maker's independent
  consumer proof.
- Preserve current live broker, collector, archive-forwarder, and strategy-spool
  behavior.

**Non-Goals:**

- Adding a broker RPC, `ExecuteAction`, always-on backfill coordinator, or vendor
  fetching to the archive-forwarder.
- Guaranteeing exactly-once vendor billing across independent hosts; v1
  guarantees deterministic archive effects and reduces duplicate fetches with
  a second qualified preflight.
- Advertising MEXC or exact L2 reconstruction before real provider data and
  venue-specific continuity rules prove support.
- Letting Maker consume vendor response files or unqualified physical archive
  rows.
- Importing or executing Fiet Maker loaders or position policy inside CEX
  Broker.
- Publishing licensed vendor payloads as repository fixtures or evidence.

## Decisions

### 1. The library is the CEX product; Fiet TEE owns file/CLI execution

The reusable entrypoint is:

```ts
runMarketDataVendorBackfill(request, dependencies): Promise<BackfillResult>
```

It lives under `src/helpers/market-data-vendor-backfill/` and is exported through
`@usherlabs/cex-broker/market-data-vendor-backfill`. Dependencies cover archive
queries, provider registry/adapters, forwarder submission, clock, and bounded
logging. Core code returns a complete typed result and performs no process exit
or result-path mutation. Fiet TEE validates CLI paths, resolves secrets, invokes
the core, and atomically renames a complete result file.

This avoids loading `src/index.ts`, which imports the gRPC/server runtime, and
keeps the CEX package usable in both conformance and TEE bundles.

**Alternative considered:** add the command to the ordinary `cex-broker` server
CLI. Rejected because the current CLI requires broker policy/server options and
would blur bounded tool and service lifecycles.

### 2. Request identity, attempt identity, and capture identity are separate

`requestId` binds the caller's durable Maker attempt. `idempotencyKey` is the
canonical SHA-256 of business fields excluding caller path, secrets, and
request/result filenames. The worker validates the supplied key. A
content-addressed `captureBundleId` additionally binds provider object checksums,
adapter version, canonical schema, and checksum algorithm. A rerun with identical
business scope and dataset content therefore reuses the same capture and batch
identities, while changed upstream content produces a different capture bundle.

Promotion receipt identity is the canonical hash of stable semantic receipt
content. `verificationTimeMs` is audit metadata and is excluded from request,
capture, and semantic digest identities.

### 3. External producer provenance is generic and cannot configure the broker

Market capture gains `external_backfill`, but the normal
`BrokerArchiveSource`/environment parser remains closed to `broker_read` and
`broker_write`. The vendor path constructs a separate `MarketArchiveSource`
context. Vendor identity is `provider=cryptohftdata`; v1 source mode is
`historical_vendor_orderbook_v1`; earliest retained evidence uses
`raw_capture_scope=vendor_normalized_dataset_file`.

This describes what CEX received without falsely claiming exchange-wire bytes
or creating one archive source enum per vendor.

### 4. Capability is a data profile, not possession of credentials

Provider adapters expose a side-effect-free/static support mapping plus an
optional public symbol discovery probe. Capability is evaluated before the
credential resolver. A profile includes provider exchange ID, market type,
symbol normalization, accepted event-time units, snapshot grouping rules,
sequence semantics, supported construction modes, supported source policies,
maximum depth/window, and adapter version.

Initial enablement is conservative: sampled top-N and
`authoritative_window` only for profiles backed by synthetic contract tests and
an opt-in real provider hash-only smoke. `fill_gaps`, exact L2, MEXC, or an
unproven timestamp/sequence profile returns `capability_unsupported`. The
interfaces are designed so later profiles can add those capabilities without
changing v1 wire schemas.

### 5. Vendor files are replayed into snapshots before canonicalization

The CryptoHFTData adapter enumerates bounded UTC-hour object paths including a
bounded pre-window initialization lookback. It authenticates by obtaining a
short-lived token from an environment/secure-secret API key, then uses a bearer
header for downloads. Object bytes are hashed before decoding. A pure Node/Bun
Parquet and outer-Zstd path is used so the Fiet TEE bundle does not shell out to
Python, DuckDB, or a sibling checkout.

Rows are normalized without first converting sequence IDs or timestamps through
unsafe integers. Consecutive `snapshot` rows form one reset group. Ordered
`update` rows replace or delete (`quantity=0`) one price level. Venue-profile
logic validates all available update IDs. At each required clock timestamp the
engine emits the latest prior-as-of non-crossed top-N book if it satisfies the
request's lag and boundary rules. The existing canonical row builder supplies
capture-core fields, snapshot IDs, summaries, and normalized-row checksums.

V1 labels the emitted artifact `sampled_top_n_snapshot` even though it was
replayed from deltas; it does not set the exact-reconstruction flag until every
source update in the qualified interval has a venue-specific continuity proof.

### 6. Producer-owned deterministic batching is sufficient for v1

The worker serializes rows to calculate both row-count and byte limits, groups by
table, and emits deterministic chunks. `batch_id` hashes capture bundle, table,
chunk ordinal, and chunk content. A bounded retry policy resubmits the same
batch. Because the forwarder already maps batch IDs to ClickHouse insertion
deduplication tokens, an ambiguous commit or restarted worker can safely
resubmit.

No new SQLite durability class is added. On a terminal failure, landed physical
rows remain unqualified. A later invocation may download again but produces the
same archive identities when provider content is unchanged.

**Alternative considered:** reuse the `hb_runtime` spool. Rejected because its
schema, acknowledgement, quota, and ownership contract are deliberately limited
to live strategy tables.

### 7. Qualification is a separate append-only table and view layer

Add `market_data.cex_order_book_capture_promotions`. It contains only passing
receipt rows and uses receipt identity as its deterministic logical key. The
forwarder applies a strict external-backfill promotion contract before insertion.

Existing base and canonical views remain unchanged so operations and the worker
can inspect candidate rows before promotion. New replay-qualified views:

```text
broker_read / broker_write canonical rows
    ───────────────────────────────────────┐
                                           ├─ replay-qualified view
external_backfill canonical rows ─ join ─ passing promotion
```

The join binds capture bundle, exchange, pair, window, depth, construction mode,
and schema—not merely bundle ID. Coverage preflight and exporter use the
qualified views. This makes promotion a last-write commit marker and keeps
partial rows harmless to replay consumers.

### 8. Historical external data is exempt from the live source-time TTL

The order-book base-table TTL becomes conditional: the existing 90-day policy
continues for broker-origin rows, while `external_backfill` evidence is excluded
from that deletion expression. Promotion rows have no shorter retention than
the captures they qualify. This is necessary because source timestamps older
than 90 days are otherwise eligible for deletion as soon as they are inserted.

Rollback drops qualified views and stops accepting new external batches before
reverting the application. Physical external rows and promotion evidence are
preserved until an explicit retention decision; rollback never deletes them.

### 9. FIET-1017 is two bound proofs, not a CEX-to-Maker dependency cycle

Before promotion, the worker records qualified prefix/suffix semantic digests.
After ingestion it queries the candidate bundle through existing canonical
views, checks exact canonical key/checksum equivalence with its normalized
projection, rechecks prefix/suffix, validates conflicts, sequence/seams,
depth/construction, future leakage, and required-clock coverage, then validates
the CEX canonical export projection. Passing facts form the receipt and are
inserted last.

Maker then independently queries replay-qualified views and runs its actual
loader. Maker evidence binds receipt, post-promotion query, and final hashes.
FIET-1017 aggregate evidence requires both. This preserves ownership and avoids
importing Python/Hummingbot code into the CEX package.

### 10. Licensed provider evidence is hash-only outside the archive

Committed tests use synthetic records matching the public schema and edge cases.
An opt-in real-provider test may fetch a small supported interval, but persisted
evidence contains only provider/object identities, versions, counts, and
cryptographic hashes. Logs and failures redact authorization headers, API keys,
tokens, URLs with userinfo/query secrets, and response bodies that could contain
credentials.

## Risks / Trade-offs

- [Vendor schema or exchange timestamp semantics change] → Pin adapter profiles
  and schema expectations, validate every decoded column, and fail unsupported
  before promotion.
- [Two hosts pass preflight and both download] → Accept possible duplicate
  acquisition cost in v1 while guaranteeing identical archive effects; add a
  distributed lease only if billing semantics require it.
- [Content-addressed bundle changes when vendor corrects a file] → Produce a new
  bundle/receipt and preserve both histories; never overwrite old evidence.
- [Qualification join accidentally broadens scope] → Bind all scope/schema
  columns and cover mismatches in real ClickHouse tests.
- [Conditional TTL behaves differently across ClickHouse versions] → Exercise
  the exact production/pinned ClickHouse schema and TTL merge behavior before
  release.
- [Full-depth hourly files exceed memory] → Stream/decode by bounded object and
  release raw bytes after hashing/replay; enforce request file/byte/row budgets.
- [Parquet/Zstd dependency fails Fiet TEE bundling] → Prefer pure Node/Bun
  libraries, add package-subpath bundle smoke, and make Fiet TEE packaging a
  release prerequisite.
- [Standard vendor licence conflicts with artifact sharing] → Keep data and
  derived rows internal, publish no payload fixtures, and block broader delivery
  until the data owner confirms rights.

## Migration Plan

1. Land contracts, dependency interfaces, capability registry, and public
   package subpath with fake dependencies and closed state-machine tests.
2. Add promotion DDL, strict forwarder contract, qualified views, conditional
   TTL, reusable archive-reader logic, and real ClickHouse tests. Deploy schema
   before any external-backfill producer is enabled.
3. Add the CryptoHFTData decoder/replay adapter behind a default-empty enabled
   capability set; run synthetic and opt-in provider conformance.
4. Enable the first proven Binance profile, run an authoritative-window
   FIET-1017 promotion against an isolated archive, and retain hash-only evidence.
5. Publish an unused CEX Broker patch version containing the package subpath.
   Fiet TEE pins it and ships the separate executable; Maker pins both and runs
   its independent query/consumer gate.
6. Add `fill_gaps`, further venues, or exact L2 only through later proven
   profiles/spec deltas.
7. Rollback by disabling provider profiles and the Fiet TEE command first,
   retaining qualification/data tables, then reverting readers to existing
   canonical views. Never delete capture evidence as part of application
   rollback.

## Open Questions

- Which Binance spot or futures pair/window is the first licensed FIET-1017
  positive-control scope?
- Should production eventually require a separate archive-forwarder credential
  for promotion rows, beyond the strict row/source contract and trusted network?
- What explicit retention duration replaces indefinite retention if internal
  archive policy later requires one for external historical data?
- Is cross-host duplicate vendor charging material enough to justify a future
  distributed acquisition lease?
