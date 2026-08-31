# maker-archive-sidecar-conformance Specification

## Purpose

Define the CEX-owned conformance sidecar, Maker-owned orchestration boundary, truthful native and production-compatible profiles, secret-free evidence, and deterministic cross-service completion contract.

## Requirements

### Requirement: CEX Broker provides a bounded archive-conformance sidecar lifecycle

CEX Broker SHALL provide a bounded, non-production sidecar lifecycle for the `production_compatible` profile only. It SHALL retain the established `up|ready|verify|down` lifecycle: `up` starts deterministic infrastructure and writes the v2 manifest, `ready` reports bounded readiness for external Maker execution, `verify` evaluates the resulting shared-wire Proof C and writes the v2 result, and `down` cleans up owned resources. It SHALL NOT expose a native replay profile or execute Maker sourcing, policy, loader, or Parquet behavior.

#### Scenario: Production-compatible sidecar is started

- **WHEN** an orchestrator invokes `up` with a unique run ID, pinned commits, and `production_compatible`
- **THEN** the composition SHALL start run-isolated ClickHouse, the production archive-forwarder with a unique durable spool, the controlled broker fixture through normal gRPC wiring, and the independent collector entrypoint
- **AND** it SHALL write a v2 manifest and expose only bounded test endpoints

#### Scenario: Production-compatible readiness is requested

- **WHEN** the orchestrator invokes `ready`
- **THEN** readiness SHALL require broker gRPC, ClickHouse schema, forwarder health, spool writability, and configured collector subscription readiness
- **AND** it SHALL fail within the configured bounded timeout if any component is unavailable

#### Scenario: Production-compatible verification completes

- **WHEN** external Maker execution has exercised live gRPC and durable `hb_runtime` wires and the orchestrator invokes `verify`
- **THEN** verification SHALL succeed or fail solely from bounded Proof C evidence
- **AND** it SHALL write the v2 result without executing Maker policy, sourcing, loader, or Parquet behavior

#### Scenario: Production-compatible sidecar is stopped

- **WHEN** an orchestrator invokes `down` after success, failure, or interruption
- **THEN** shutdown SHALL be bounded and idempotent and remove only run-owned resources
- **AND** it SHALL retain only explicitly selected bounded evidence

#### Scenario: Native replay profile is unavailable

- **WHEN** an orchestrator invokes `up --profile native_replay` or requests a native result, reference export, or replay validator
- **THEN** the sidecar SHALL reject the request as an invalid unsupported profile or artifact
- **AND** it SHALL NOT emit a v1-compatible result

### Requirement: The sidecar exposes a stable non-interactive command contract

The repository SHALL expose `bun run archive:sidecar -- <up|ready|verify|down>` for `production_compatible`. `up` SHALL require `--run-id`, `--profile production_compatible`, `--candidate-sha`, `--maker-sha`, and `--artifacts-dir`, and SHALL write `<artifacts-dir>/<run-id>/manifest.json`. `ready`, `verify`, and `down` SHALL require `--manifest <path>`; `ready` SHALL retain its `--timeout-ms` default of `120000`; and `verify` SHALL write `<artifacts-dir>/<run-id>/verification.json`. Inputs and outputs SHALL use version-2 schemas only. Exit code `0` SHALL mean success, `2` invalid invocation or manifest, and `1` lifecycle, readiness, or verification failure. The removed `native_replay` profile SHALL NOT be accepted by `up`; no replacement `prepare|execute|cleanup` command family SHALL be introduced by this change.

#### Scenario: Automation invokes the supported profile

- **WHEN** CI supplies resolved CEX and Maker commits, fixture identity, output directory, and time bounds
- **THEN** `up`, `ready`, `verify`, and `down` SHALL run non-interactively
- **AND** produced paths and status codes SHALL be machine-readable

#### Scenario: Removed command and profile shapes fail explicitly

- **WHEN** automation invokes `up --profile native_replay` or a proposed `prepare`, `execute`, or `cleanup` verb
- **THEN** the command SHALL exit non-zero with a machine-readable unsupported-command or unsupported-profile diagnostic
- **AND** it SHALL NOT reinterpret the invocation as `production_compatible`

#### Scenario: Readiness times out

- **WHEN** a required component remains unavailable for 120 seconds or the explicit bounded timeout
- **THEN** `ready` SHALL return exit code `1` and retain bounded diagnostics in the run artifact directory
- **AND** it SHALL NOT emit successful readiness

#### Scenario: Invocation or manifest is invalid

- **WHEN** a required flag is absent, a commit is invalid, or a manifest fails v2 validation
- **THEN** the command SHALL return exit code `2` without claiming lifecycle or conformance success

#### Scenario: Verification fails

- **WHEN** any Proof C assertion fails
- **THEN** `verify` SHALL return exit code `1` and write a failed secret-free v2 result
- **AND** `down` SHALL remain usable and idempotent for the same manifest

#### Scenario: V1 result cannot be decoded

- **WHEN** verify receives a sidecar manifest or result using the deleted v1 schema
- **THEN** it SHALL fail with an unsupported-schema error
- **AND** it SHALL NOT upgrade, alias, or infer missing v2 evidence

### Requirement: The sidecar uses production boundaries without production credentials

The sidecar SHALL exercise the real CEX Broker current/live ORDERBOOK gRPC boundary, the production acquisition-profile and collector/feed-sharing paths, the normal archive-forwarder HTTP boundary, durable spool admission, and the production ClickHouse strategy tables. Proof C SHALL use a deterministic controlled/local fixture venue and SHALL NOT require public-network market access, production secrets, external vendor credentials, or a production deployment. “Real broker” SHALL mean production handlers and domain paths, not a live public exchange.

#### Scenario: Layer12 reaches the real broker

- **WHEN** Proof C requests current depth and subscribes to live ORDERBOOK through Layer12
- **THEN** the request SHALL traverse the registered production broker handler and return a valid live-boundary result
- **AND** the observation SHALL originate from the controlled fixture venue through the production acquisition-profile path

#### Scenario: Strategy write uses durable production semantics

- **WHEN** Maker's ArchiveEmitter posts an `hb_runtime` batch through the production-compatible forwarder
- **THEN** HTTP 202 SHALL be returned only after durable spool admission
- **AND** the spool SHALL drain the expected identities into all five strategy tables

#### Scenario: No production secret is required

- **WHEN** the sidecar runs in CI
- **THEN** deterministic local fixtures and credentials SHALL be sufficient without public market access
- **AND** the manifest SHALL contain no secret material

#### Scenario: Public-network smoke is separate and optional

- **WHEN** maintainers run an external public-market smoke test
- **THEN** it SHALL be a separately named non-gating job
- **AND** its result SHALL NOT be included in or required by Proof C verification

#### Scenario: Core broker configuration is unchanged

- **WHEN** sidecar support is reviewed
- **THEN** it SHALL introduce no credential profile, credential-source policy, runtime archive write mode, or mandatory archive configuration for the core broker
- **AND** ordinary production archival startup behavior SHALL remain independent of sidecar fixtures

### Requirement: Sidecar evidence is bounded, reproducible, and secret-free

The v2 manifest and v2 result SHALL record resolved CEX and Maker commits, bounded timestamps and row identities, the hash-bound shared-wire fixture/test identity, broker/collector feed-sharing evidence, archive-decision cardinality, 202/spool evidence, and exact producer/run identities in the five strategy tables. They SHALL NOT contain Parquet descriptors, `parquetOwnership`, native replay results, FIET-907 loader evidence, policy-equivalence evidence, PR-number ancestry, credentials, or unbounded payloads.

#### Scenario: Evidence can be independently rechecked

- **WHEN** a reviewer receives a successful v2 result
- **THEN** the reviewer SHALL be able to resolve both commits, verify the fixture hash, locate the bounded rows, and reproduce the Proof C assertions

#### Scenario: Secrets and obsolete proof fields are absent

- **WHEN** the result directory is scanned
- **THEN** it SHALL contain no tokens, passwords, private endpoints, canonical Parquet artifacts, native profile records, Proof B decisions, or FIET-907 loader outputs

#### Scenario: External Maker producer is handed off safely

- **WHEN** the sidecar becomes ready for Maker-owned Layer12 and ArchiveEmitter execution
- **THEN** its manifest SHALL expose only the loopback endpoints and bounded identities needed by that producer
- **AND** any ephemeral authorization material SHALL remain outside retained evidence and be removed by `down`

#### Scenario: Sidecar cannot substitute for Maker

- **WHEN** a CEX sidecar component constructs or posts the strategy rows used as ArchiveEmitter evidence
- **THEN** conformance SHALL fail because the external-producer boundary was bypassed
- **AND** CEX-generated substitute rows SHALL not count in the five strategy-table queries

### Requirement: FIET Maker owns external orchestration from a pinned develop checkout

Maker MAY own a development-only dual-repository orchestration that pins exact CEX and Maker commits and invokes the CEX production-compatible sidecar. The orchestration SHALL bind the current shared-wire fixture/test by content hash and SHALL NOT require ancestry from a named pull request. Production thesis materialization SHALL remain independent of the CEX checkout and sidecar.

#### Scenario: Development orchestration pins content

- **WHEN** Maker invokes the sidecar in cross-repository CI
- **THEN** both repositories SHALL be clean at resolved commits
- **AND** the shared-wire test identity and digest SHALL match the manifest

#### Scenario: Pull-request ancestry is not a pass condition

- **WHEN** equivalent shared-wire code is rebased, merged, or carried by a different commit topology
- **THEN** verification SHALL rely on the resolved content-bound fixture and observed wire evidence
- **AND** it SHALL NOT require ancestry from PR 1067 or any other PR number

### Requirement: Production-compatible Maker conformance exercises live and durable boundaries

The production-compatible profile SHALL prove that Layer12 can fetch and subscribe to live depth through the real broker, Maker and the collector can share one physical feed with one archive decision per observation, and ArchiveEmitter `hb_runtime` writes receive durable 202 admission and drain to the five strategy tables with exact producer and run identities.

#### Scenario: Shared physical feed has one archive decision

- **WHEN** Layer12 and the collector observe the same bounded live feed during Proof C
- **THEN** evidence SHALL identify one physical subscription/feed owner
- **AND** each physical observation SHALL produce no more than one broker archive decision

#### Scenario: Five-table strategy persistence is exact

- **WHEN** the spool drains an accepted `hb_runtime` batch
- **THEN** the expected rows SHALL appear in each required strategy table
- **AND** producer id, run id, batch identity, and expected row counts SHALL match the v2 manifest

### Requirement: Cross-service verification enforces source and ownership boundaries

Sidecar verification SHALL enforce only the remaining shared transport and storage ownership boundary. CEX-local Proof A and Maker-owned Proof B SHALL NOT be prerequisites or result fields. The sidecar SHALL NOT claim hot-summary reader parity; that boundary SHALL be verified by the versioned summary-v2 fixture/query contract and MAY be supplemented by an optional SQL compatibility job.

#### Scenario: Proof C is sufficient

- **WHEN** all live gRPC, feed-sharing, archive-decision, durable-202, spool-drain, and five-table assertions pass
- **THEN** sidecar verification SHALL report success without a CEX reference export or Maker policy result

#### Scenario: Hot schema parity remains separate

- **WHEN** the sidecar succeeds but a downstream summary-v2 reader fixture fails
- **THEN** the sidecar result SHALL remain a truthful shared-wire result
- **AND** the independent schema-compatibility gate SHALL fail until the reader is corrected

#### Scenario: Ownership boundary is crossed

- **WHEN** a component performs another repository's sourcing, policy, loader, or strategy-producer work and thereby bypasses a required shared wire
- **THEN** verification SHALL fail with the skipped boundary identified
- **AND** that result SHALL not count toward release evidence

### Requirement: Deterministic cross-service evidence replaces production soak for this change

The sidecar SHALL use bounded deterministic evidence to catch shared-wire drift before release. It SHALL NOT claim availability, exchange fidelity, production retention, or long-duration soak coverage.

#### Scenario: Deterministic pass has bounded meaning

- **WHEN** Proof C passes within its configured time and row limits
- **THEN** the result SHALL attest only to the exercised live gRPC and durable strategy-write compatibility
- **AND** release documentation SHALL not characterize it as production soak evidence
