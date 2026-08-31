## Why

CEX Broker currently mixes its production live-exchange archive role with a Maker-specific historical vendor preparation product, and its ClickHouse ORDERBOOK path still writes an unbounded normalized snapshot body alongside bounded level rows. The active depth-sourcing specification also lets archived levels stand in for Maker-policy evidence, while the active `complete-maker-preparation-output-contract` change continues to add the product this change removes. The Maker hot/cold architecture now owns direct historical reads and reconstruction, so CEX must establish one unambiguous live-only, bounded, policy-neutral hot contract and retain cross-repository conformance only for the shared live wires.

## What Changes

- Keep current snapshot, `Subscribe(ORDERBOOK)`, in-memory live L2 band-coverage, and CEX-local Proof A behavior while preserving one broker-owned sampled archive decision per physical live observation.
- Explicitly supersede `complete-maker-preparation-output-contract`; remove it from the active change set without synchronizing its delta specs, and do not execute its remaining tasks or publish its preparation release.
- **BREAKING** remove CEX-owned vendor acquisition, source-tape and required-clock qualification, historical ClickHouse admission/promotion, preparation package exports, and canonical Parquet exporters.
- **BREAKING** reject `source = external_backfill` explicitly and retire its evidence tables, qualification views, retention exception, archive-cluster identity, and vendor-only provenance fields through a controlled terminal migration.
- **BREAKING** cut the hot summary writer and supported query surface directly to `schema_version = "2.0.0"`; no v1 summary producer, reader, alias, compatibility view, schema laundering, or legacy-migration summary emission remains active.
- Keep bounded top-N level rows as policy-neutral analytical and diagnostic evidence, but make summary v2 the sole hot `exact|censored` depth contract. Persisted levels cannot repair missing or censored summary claim rights or reproduce a Maker position policy.
- Split summary schema identity from stable capture/level identity: the complete-observation raw identity and retained-N snapshot identity remain capture schema `1.0.0`, while only the summary row is `2.0.0`.
- Replace full ORDERBOOK raw JSON with a closed, structurally bounded metadata schema plus the checksum of the complete normalized observation; no full-body diagnostic fallback remains.
- Thin the CEX conformance sidecar to the remaining shared wires: live Layer12 gRPC access and durable `hb_runtime` ArchiveEmitter delivery. Preserve the existing `up|ready|verify|down` verbs and a deterministic controlled venue, remove `native_replay`, CEX Parquet, FIET-907 loader, Maker policy-equivalence, and combined Proof A/B pass conditions, and make CEX-owned shared-wire Proof C sufficient.
- Add a versioned summary-v2 fixture and ClickHouse query contract for downstream reader parity without requiring the sidecar, a CEX checkout, or a CEX package at thesis runtime.
- Add a repository instruction that superseding internal implementations are deleted rather than kept behind compatibility paths unless an operator explicitly requires backward compatibility.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cex-broker-service-architecture`: assign CEX only live acquisition and policy-neutral hot writes; remove the historical preparation/export ownership and document hard-cutover policy.
- `cex-broker-order-book-depth-sourcing`: preserve current/live L2 projection and Proof A coverage while assigning persisted hot claim rights exclusively to summary v2 and removing Maker-policy replay from CEX archive requirements.
- `cex-market-data-replay-capture`: restrict archive sources to broker-owned live capture and replace ORDERBOOK full raw JSON with bounded metadata.
- `cex-order-book-replay-archive`: define summary v2 exact/censored semantics, diagnostic-only levels, v2-only supported views, uniform hot retention, and terminal removal of vendor archive objects.
- `archive-e2e-regression`: replace promotion/export coverage with v2 hot-writer, bounded-raw, external-source rejection, and final-schema assertions.
- `maker-archive-sidecar-conformance`: delete native replay/Parquet conformance and retain a thinner production-compatible shared-wire Proof C contract.
- `market-data-vendor-backfill`: remove the complete CEX-owned vendor-backfill capability.
- `cex-market-data-preparation-executables`: remove the complete preparation package and executable capability.

## Impact

- Affects the public npm package by removing historical preparation subpaths and bins; the final release requires a breaking `0.3.x` version.
- Affects the live market archive writer, public-feed-to-archive metadata handoff, archive-forwarder admission, ClickHouse order-book schema/views, E2E fixtures, conformance sidecar, documentation, and operational migrations.
- Supersedes the active `complete-maker-preparation-output-contract` change without applying or synchronizing that change's remaining ADDED/MODIFIED requirements.
- Preserves the broker gRPC current/live ORDERBOOK contract, normal `/archive` delivery, strategy `hb_runtime` durable acceptance, generic TICKER/TRADES/OHLCV raw behavior, bounded level rows, canonical conflict handling, and the 90-day hot-layer role.
- Does not implement Maker hot/cold sourcing, CryptoHFTData reconstruction, FIET-1015 policy materialization, FIET-907 materialization, packed ClickHouse arrays, or retention beyond 90 days.
