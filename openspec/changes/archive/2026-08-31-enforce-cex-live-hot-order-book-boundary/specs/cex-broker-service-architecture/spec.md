## ADDED Requirements

### Requirement: CEX Broker owns only the live hot market-data boundary

CEX Broker SHALL own live exchange acquisition, current/live broker RPCs, and policy-neutral ClickHouse hot writes. It SHALL NOT own vendor-object acquisition, historical reconstruction, source-tape or required-clock qualification, backtest preparation, Maker policy materialization, or FIET-907 sourcing.

#### Scenario: Live order-book behavior remains available

- **WHEN** a supported client requests the current ORDERBOOK snapshot or subscribes to live ORDERBOOK updates
- **THEN** CEX Broker SHALL serve the existing live gRPC contract
- **AND** an enabled archive deployment MAY persist one bounded hot observation for the physical live feed

#### Scenario: Historical preparation is outside the broker product

- **WHEN** an operator installs, packs, or runs the CEX Broker release
- **THEN** the release SHALL expose no vendor backfill, historical reconstruction, source-tape, required-clock, canonical Parquet, or Maker preparation executable, subpath, or service

### Requirement: Superseded internal boundaries use a hard cutover

When this repository supersedes an internal contract, it SHALL remove the obsolete implementation, writer, reader, schema alias, compatibility view, adapter, and documentation unless an operator has explicitly approved a backward-compatibility requirement. A repository instruction SHALL record this default.

#### Scenario: No implicit compatibility surface survives

- **WHEN** summary v2 and the live/hot ownership boundary become authoritative
- **THEN** reviewers SHALL find no active summary-v1 producer, reader, alias, compatibility view, historical preparation adapter, or deprecated command retained for convenience

#### Scenario: Compatibility requires an operator decision

- **WHEN** an implementation proposes to keep a superseded surface
- **THEN** the change SHALL identify the operator requirement, bounded lifetime, owner, and removal condition
- **AND** absence of those facts SHALL require deletion

## MODIFIED Requirements

### Requirement: Migration and replay tools retain direct ClickHouse boundaries

CEX-owned migration and replay diagnostics SHALL operate directly against CEX-owned ClickHouse hot tables and SHALL remain separate from the live gRPC server. CEX SHALL NOT proxy Maker historical data through a file exporter, preparation package, or runtime repository dependency.

#### Scenario: CEX diagnostic reads hot data directly

- **WHEN** a CEX operator runs a supported hot-archive diagnostic or migration tool
- **THEN** the tool SHALL query or mutate the named ClickHouse objects directly
- **AND** it SHALL NOT require Maker code, a Maker checkout, or a generated canonical Parquet artifact

#### Scenario: Downstream consumers own their own readers

- **WHEN** a downstream system consumes the CEX hot archive
- **THEN** it SHALL use the published ClickHouse schema/query contract independently
- **AND** CEX SHALL NOT provide a historical file handoff as a substitute for that reader

### Requirement: Maker profiles document truthful runtime boundaries

CEX documentation SHALL describe only the production-compatible Maker conformance profile that exercises shared live gRPC and durable strategy-write wires. It SHALL identify historical sourcing, reconstruction, policy equivalence, and replay materialization as Maker-owned behavior outside the CEX sidecar.

#### Scenario: Production-compatible profile is documented

- **WHEN** an operator reviews CEX-to-Maker conformance instructions
- **THEN** the documented sidecar profile SHALL be `production_compatible`
- **AND** its pass condition SHALL be the shared-wire Proof C result

#### Scenario: Thesis materialization is independent

- **WHEN** Maker materializes or replays a thesis
- **THEN** the documented workflow SHALL NOT require `--cex-repo`, a CEX package, a CEX executable, a sidecar result, or a CEX-generated Parquet file

### Requirement: Cross-repository conformance ownership is explicit

Cross-repository conformance SHALL follow only the shared wires. CEX SHALL own feed/coalescing Proof A in its local regression suite, Maker SHALL own policy-equivalence Proof B, and the production-compatible sidecar SHALL own shared live-and-durable-wire Proof C. Hot summary reader parity SHALL use the versioned summary-v2 fixture/query contract and MAY additionally use an optional cross-repository SQL compatibility job.

#### Scenario: Sidecar success does not aggregate unrelated proofs

- **WHEN** the production-compatible sidecar completes Proof C successfully
- **THEN** the sidecar SHALL succeed without executing or evaluating Proof A, Proof B, FIET-907 loaders, Maker replay policy, or canonical Parquet output

#### Scenario: Hot reader parity is independently testable

- **WHEN** a downstream repository validates its ClickHouse hot reader
- **THEN** it SHALL be able to pin or copy the versioned fixture and verify its digest
- **AND** it SHALL NOT need a running CEX sidecar or CEX runtime dependency

## REMOVED Requirements

### Requirement: The published subpath exposes the complete final-v1 library boundary

**Reason**: The published preparation library is outside the live/hot CEX ownership boundary and retaining its subpath would preserve an obsolete runtime dependency.

**Migration**: Consumers SHALL move historical acquisition, reconstruction, and preparation into Maker-owned FIET-1015 paths before the breaking CEX `0.3.x` release.

### Requirement: Market-data vendor backfill is a bounded archive tool

**Reason**: Vendor sourcing and historical-write responsibility now belong to Maker, not CEX Broker.

**Migration**: Stop all CEX vendor workers, reject historical admission, and use Maker's direct vendor-object cold reader.

### Requirement: Cross-repository backfill proof ownership is explicit

**Reason**: There is no remaining CEX-to-Maker backfill product to prove across repositories.

**Migration**: Keep CEX feed/coalescing proof in CEX, keep sourcing and policy proof in Maker, and use only the shared-wire sidecar plus the v2 hot-schema fixture at the boundary.
