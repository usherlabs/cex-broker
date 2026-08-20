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

This amendment supersedes every unpublished provisional v1 wire shape below
where they conflict. Wire documents use snake_case, strict JSON Schema Draft
2020-12 validation, RFC 8785 JCS plus SHA-256 identities, lowercase UUIDs and
hex digests, fixed UTC RFC3339 timestamps, safe integers, and no floating-point
fields. A document identity omits only that document's own digest field. The
existing capture-row and capture-bundle checksum algorithms are intentionally
unchanged.

The initial provider publishes hourly Zstd-compressed Parquet objects containing
normalized L2 snapshot and price-level update records. Its current documented
exchange set does not include MEXC, and its standard licence permits internal
research rather than redistribution. A live-proven OKX Spot ARB-USDT object at
`2026-08-18T09:27:15.308Z` supplies the initial complete snapshot positive
control. The implementation therefore needs a truthful capability matrix and
synthetic public fixtures.

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

`request_id` binds the caller's durable Maker attempt. `idempotency_key` is the
canonical SHA-256 of business fields excluding caller path, secrets, and
request/result filenames. The worker validates the supplied key. A
content-addressed `capture_bundle_id` additionally binds provider object checksums,
adapter version, canonical schema, and checksum algorithm. A rerun with identical
business scope and dataset content therefore reuses the same capture and batch
identities, while changed upstream content produces a different capture bundle.

`promotion_identity_sha256` is the canonical hash of stable semantic promotion
content. `receipt_id` separately hashes the complete receipt, including its
fixed UTC `verified_at` timestamp. Verification time remains excluded from
request, capture, and semantic promotion identities.

### 3. External producer provenance is generic and cannot configure the broker

Market capture gains `external_backfill`, but the normal
`BrokerArchiveSource`/environment parser remains closed to `broker_read` and
`broker_write`. The vendor path constructs a separate `MarketArchiveSource`
context. Vendor identity is `provider=cryptohftdata`; v1 source mode is
`vendor_historical_backfill_v1`; earliest retained evidence uses
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
bounded pre-window initialization lookback. The acquisition policy fixes the
effective initialization lookback independently from the resource policy's
maximum; v1 uses the containing UTC-hour object only (`0ms` additional
lookback). It authenticates by obtaining a
short-lived token from an environment/secure-secret API key, then uses a bearer
header for downloads. Object bytes are hashed before decoding. A pure Node/Bun
Parquet and outer-Zstd path is used so the Fiet TEE bundle does not shell out to
Python, DuckDB, or a sibling checkout.

Rows are normalized without first converting sequence IDs or timestamps through
unsafe integers. Consecutive `snapshot` rows form one reset group. Ordered
`update` rows replace or delete (`quantity=0`) one price level. Venue-profile
logic validates all available update IDs. Binance profiles use `U/u/pu`; the
live-proven OKX profile groups snapshots by event time and `seqId`, requires the
snapshot `prevSeqId=-1` sentinel, and links every update's `prevSeqId` to the
current `seqId`. A linked OKX maintenance reset or heartbeat remains valid even
when the new sequence is lower or unchanged. Updates preceding the first
complete snapshot at or before the earliest requested clock are ignored; the
adapter never invents state from that delta prefix. At each required clock
timestamp the engine emits the latest prior-as-of non-crossed top-N book if it
satisfies the request's lag and boundary rules. The existing canonical row
builder supplies capture-core fields, snapshot IDs, summaries, and
normalized-row checksums.

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

### 11. Live-provider promotion is a protected CEX release gate

The adapter-only provider conformance probe and synthetic ClickHouse tests leave
one seam unproven: real licensed vendor bytes have not passed through
normalization, HTTP forwarder admission, candidate verification, promotion, and
qualified replay in one invocation. An explicit smoke therefore runs that path
against an ephemeral `clickhouse/clickhouse-server:24.8` instance. It runs the
same request twice and requires `promoted` followed by `already_covered` without
additional rows or promotion evidence.

The smoke is available through one local package command and a protected
`workflow_dispatch` environment. It is never scheduled and never runs in pull
request CI. Its API key is environment-injected, its positive-control window is
explicit, and its persisted pass/fail evidence is a closed secret-free
projection. This gate blocks declaring the initial provider profile ready; it
does not block unrelated CEX Broker releases. Fiet TEE still owns packaged
executable conformance, and Maker still owns the independent qualified-reader
and actual-loader proof.

### 12. Published contracts are schemas, not TypeScript implementation details

The package ships request, result, required-clock, archive-selection, and
promotion-receipt JSON Schemas plus capability/resource policy schemas,
manifests, canonical digests, and golden fixtures. Ajv validates wire input and
codecs map it to internal domain types. `canonicalize@4.0.0` is the only JCS
serializer used for these identities; the capture checksum helper is not reused
because it deliberately removes checksum-named fields.

The request contains canonical scope/window/depth/construction/source policy,
target environment and cluster, a required-clock reference, initial selection,
expected canonical schema, and the fully resolved
`prior-asof-strict/v1` coverage policy. Provider mappings, allowlists, object
paths, fetch margins, resource budgets, and package expectations are
deployment policy rather than request content. Product pins bind versioned
capability and resource policy IDs and JCS digests.

### 13. Archive selection is exact evidence, not a coverage boolean

Preflight returns `complete`, `partial`, or `missing` together with the exact
selected bundles and intervals, requested intervals, precedence,
qualification/receipt evidence, and exact prior-as-of `support_anchors`.
`authoritative_window` selects promoted vendor intervals only. `fill_gaps`
preserves retained production intervals and adds promoted gaps with
archive-wins precedence. `already_covered` returns the exact stored identities.

`selection_sha256` binds the entire selection except itself. Selection and
receipt readers recompute identities, reject mismatches, and reject conflicting
stored content. Enough resolved selection and receipt content is persisted to
return the original document on idempotent reuse.

### 14. Receipt occurrence identity is distinct from semantic deduplication

`promotion_identity_sha256` hashes the stable semantic promotion content and is
used only for deduplication. `receipt_id` hashes the full receipt including the
fixed UTC `verified_at` timestamp. Qualification is append-only with
`qualified`, `quarantined`, and `revoked` transitions. Vendor views require the
latest state to be qualified and to reference a valid final receipt; production
rows retain their existing checksum/provenance eligibility without a vendor
receipt.

### 15. Archive cluster identity and production authority fail closed

`market_data.cex_archive_cluster_identity` is a deployment-owned singleton.
The archive reader queries it and forwarder health reports the same stored
identity. Preflight requires the request environment and cluster to match both
before capability or credential resolution.

Production submission additionally binds an authorization ID, a
production-scoped credential, expiry, environment, and cluster. Missing
authorization identity is request-invalid; invalid/expired authorization or an
identity mismatch is archive-preflight-failed.

### 16. CEX returns a domain outcome inside a TEE-owned job result

The CEX runner returns the closed domain statuses `request_invalid`,
`archive_preflight_failed`, `already_covered`, `promoted`,
`capability_unsupported`, `credentials_missing`, `vendor_fetch_failed`,
`archive_ingest_failed`, and `promotion_verification_failed`. CEX retains the
post-promotion selection/qualification query and maps its failure to
`promotion_verification_failed`. Consumer insufficiency, timeout, missing or
corrupt result, and incompatible process/result state are Maker outcomes.

Fiet TEE owns the durable file-job envelope and raw request-file hash. The CEX
package exports validated codecs, JCS helpers, manifests, the runner, and a
dependency factory without importing broker/server modules.

## Risks / Trade-offs

- [Vendor schema or exchange timestamp semantics change] → Pin adapter profiles
  and schema expectations, validate every decoded column, and fail unsupported
  before promotion.
- [A documented snapshot/update object contains updates only] → Let the live
  gate fail `update_before_snapshot`, keep the candidate profile disabled, and
  require a vendor-confirmed snapshot-bearing object or separately proven
  profile. Never invent historical book state from deltas alone.
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
4. Run the protected live-provider smoke for the first proven OKX Spot
   ARB-USDT profile at `2026-08-18T09:27:15.308Z`,
   require an authoritative-window FIET-1017 promotion plus idempotent rerun
   against an isolated Server 24.8 archive, and retain hash-only evidence.
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

- Should production eventually require a separate archive-forwarder credential
  for promotion rows, beyond the strict row/source contract and trusted network?
- What explicit retention duration replaces indefinite retention if internal
  archive policy later requires one for external historical data?
- Is cross-host duplicate vendor charging material enough to justify a future
  distributed acquisition lease?
