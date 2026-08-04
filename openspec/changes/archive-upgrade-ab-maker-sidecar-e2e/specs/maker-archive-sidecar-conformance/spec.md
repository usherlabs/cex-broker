## ADDED Requirements

### Requirement: CEX Broker provides a bounded archive-conformance sidecar lifecycle

The CEX Broker repository SHALL provide a documented test composition with `up`, `ready`, `verify`, and `down` operations that an external FIET Maker job can invoke non-interactively. The composition MUST be a test utility, not a production service or an additional core broker startup mode.

#### Scenario: Sidecar is started
- **WHEN** an external job invokes `up` with a unique run ID and pinned CEX candidate commit
- **THEN** the composition MUST start run-isolated ClickHouse Server 24.8, the production archive-forwarder with a unique SQLite spool, a deterministic broker fixture using normal gRPC wiring, and the independent collector service entrypoint
- **AND** it MUST expose only the bounded broker, archive, health, and ClickHouse test endpoints needed by the job

#### Scenario: Sidecar readiness is requested
- **WHEN** the external job invokes `ready`
- **THEN** readiness MUST require broker gRPC service, ClickHouse schema, forwarder health, spool writability, and configured collector subscription readiness
- **AND** the command MUST fail within a deterministic timeout if any required component is unavailable

#### Scenario: Sidecar is stopped
- **WHEN** the external job invokes `down` after success, failure, or interruption
- **THEN** shutdown MUST be bounded and idempotent and remove only run-owned processes, containers, ports, spool, and temporary data
- **AND** it MUST retain only explicitly selected bounded evidence artifacts

### Requirement: The sidecar exposes a stable non-interactive command contract

The repository SHALL expose `bun run archive:sidecar -- <up|ready|verify|down>`. `up` MUST require `--run-id`, `--profile` with exactly `native_replay` or `production_compatible`, `--candidate-sha`, `--maker-sha`, and `--artifacts-dir`, and MUST write `<artifacts-dir>/<run-id>/manifest.json`. `ready`, `verify`, and `down` MUST require `--manifest <path>`. `ready` MUST accept `--timeout-ms` with default `120000`, and `verify` MUST write `<artifacts-dir>/<run-id>/verification.json`. Exit code `0` SHALL mean success, `2` invalid invocation or manifest, and `1` lifecycle, readiness, or verification failure.

#### Scenario: Sidecar command is invoked correctly
- **WHEN** an external job supplies every required `up` flag and a supported profile
- **THEN** the command MUST create the run directory and manifest and return exit code `0` only after owned components start
- **AND** subsequent lifecycle commands MUST operate on that manifest without requiring a process environment dump

#### Scenario: Readiness times out
- **WHEN** any required component remains unavailable for 120 seconds or the explicitly supplied bounded timeout
- **THEN** `ready` MUST return exit code `1` and retain bounded diagnostics below the run artifact directory
- **AND** it MUST NOT emit a successful readiness result

#### Scenario: Invocation or manifest is invalid
- **WHEN** a required flag is absent, a profile or commit is invalid, or the manifest cannot be validated
- **THEN** the command MUST return exit code `2` without claiming lifecycle or conformance success

#### Scenario: Verification fails
- **WHEN** any selected profile assertion fails
- **THEN** `verify` MUST return exit code `1` and write a failed secret-free verification result
- **AND** `down` MUST remain usable and idempotent for the same manifest

### Requirement: The sidecar uses production boundaries without production credentials

The composition SHALL use the production archive-forwarder HTTP handler/client, schema initializer, broker gRPC registration/Subscribe handler, canonical writer, collector process, and strategy spool worker. It MUST use a deterministic controlled exchange and MUST NOT require or accept live CEX trading credentials as conformance evidence.

#### Scenario: Deterministic market capture runs
- **WHEN** the sidecar releases controlled public market frames
- **THEN** the collector MUST keep the broker subscriptions alive and canonical rows MUST traverse the broker writer and archive-forwarder into ClickHouse
- **AND** no fake HTTP handler, research watcher, or direct fixture insertion may substitute for the claimed service boundary

#### Scenario: Core broker configuration is audited
- **WHEN** sidecar support is reviewed
- **THEN** it MUST introduce no credential profile, credential-source policy, credential attestation, runtime archive write mode, or mandatory archive configuration for the core full broker
- **AND** existing `.env`-over-in-flight credential precedence and optional archival startup behavior MUST remain unchanged

### Requirement: Sidecar evidence is bounded, reproducible, and secret-free

Each sidecar run SHALL emit a machine-readable JSON manifest and verification result. Evidence MUST include run ID, profile, resolved CEX baseline/candidate and Maker commits, capture/deployment identities, non-secret endpoints, table/schema/checksum versions, ClickHouse/Bun/Python versions, migration and spool outcomes, invoked commands, and artifact hashes. Evidence MUST whitelist fields and MUST NOT serialize process environments, tokens, CEX credentials, or unredacted credential-bearing payloads.

#### Scenario: Evidence manifest is emitted
- **WHEN** `up` and `verify` complete
- **THEN** the manifest MUST identify the exact source commits and every evidence artifact used for the result
- **AND** a consumer MUST be able to distinguish admission, drainage, migration, query, and replay assertions without reading transient logs

#### Scenario: Required identity is absent
- **WHEN** run ID, selected profile, candidate commit, Maker commit, or required schema/version evidence is missing
- **THEN** verification MUST fail rather than emit a partial conformance success
- **AND** the failure artifact MUST remain secret-free

### Requirement: FIET Maker owns external orchestration from a pinned develop checkout

The required cross-repository job SHALL be initiated from a clean FIET Maker `develop` checkout, SHALL resolve and record its immutable commit at execution time, and SHALL verify that the expected PR 1067 wire contract is present. No proposal-time Maker commit SHALL act as a permanent pin. The Maker job MUST pin the CEX candidate SHA, supply a shared run identity, start the CEX-owned sidecar, execute the Maker-owned runtime/materializer command, invoke CEX verification, and always stop the sidecar.

#### Scenario: Required Maker conformance runs
- **WHEN** the Maker job resolves `develop`
- **THEN** it MUST record the Maker commit and use the CEX sidecar interface without copying CEX schema or service orchestration into Maker
- **AND** the final evidence MUST bind both repository commits to the same run ID

#### Scenario: A floating branch is used without a resolved commit
- **WHEN** a required result identifies only `develop` or a feature branch name without its resolved SHA
- **THEN** it MUST not qualify as release conformance evidence
- **AND** a scheduled floating compatibility job MAY remain informative but MUST NOT replace the pinned result

### Requirement: Native Maker replay remains an offline FIET-907-backed profile

The native replay profile SHALL represent the truthful flow `collector -> CEX Broker -> archive-forwarder -> ClickHouse -> FIET-907 materializer -> Parquet -> native Hummingbot emulation`. The retained CEX reference exporter MUST query ClickHouse directly and MUST be documented as a FIET-907 compatibility tool; CEX capture services MUST NOT produce Parquet inline. Native strategy reports MUST use `source=maker_replay` and MUST NOT claim direct broker participation by the native runtime or `hb_runtime` delivery semantics.

#### Scenario: Replay fixture boundary is exercised
- **WHEN** the native profile selects a bounded conflict-free canonical window
- **THEN** the direct-ClickHouse reference exporter or FIET-907 materializer MUST produce schema-compatible Parquet evidence and verify canonical checksums
- **AND** fixture coverage, replay-bundle assembly, and Maker-specific extensions MUST remain FIET-907/Maker ownership

#### Scenario: Native emulation reports strategy evidence
- **WHEN** the Maker emulation produces policy, identity, mapping, snapshot, or settlement rows
- **THEN** it MUST submit approved strategy rows as `maker_replay` and receive the synchronous replay contract
- **AND** queried ClickHouse rows MUST retain that source and the shared run identity

#### Scenario: Native profile claims live behavior
- **WHEN** evidence labels native emulation as directly connected to CEX Broker or labels its replay rows as `hb_runtime`
- **THEN** profile verification MUST fail
- **AND** the result MUST not satisfy production-compatible conformance

### Requirement: Production-compatible Maker conformance exercises live and durable boundaries

The production-compatible profile SHALL run the Maker Layer 12 live/sandbox boundary against the sidecar broker, with `hb_runtime` strategy rows posted to the archive-forwarder and durably admitted to SQLite before HTTP 202. The collector SHALL remain an independent broker client that keeps configured market subscriptions alive; it MUST NOT be represented as the third-party Maker client.

#### Scenario: Production-compatible profile runs
- **WHEN** Layer 12 starts with the sidecar broker endpoint and shared run identity
- **THEN** its CEX interactions MUST traverse the normal broker gRPC surface while the collector independently sustains archival subscriptions
- **AND** live strategy batches MUST receive HTTP 202 only after durable spool admission

#### Scenario: Production-compatible verification runs
- **WHEN** Maker execution completes and the sidecar worker drains admitted work
- **THEN** verification MUST query the expected market and all required strategy tables, confirm v2 producer/stream identity, and prove spool queue/table work reached completed state
- **AND** one isolated table retry or restart-recovery case MUST prove stable deduplication without duplicate logical strategy events

#### Scenario: HTTP 202 is the only available evidence
- **WHEN** a live batch was admitted but no completed spool and ClickHouse query evidence exists
- **THEN** production-compatible conformance MUST fail as incomplete
- **AND** admission MUST be reported separately from delivery

### Requirement: Cross-service verification enforces source and ownership boundaries

The verifier SHALL reject mixed strategy/non-strategy envelopes, row/envelope provenance mismatch, unsupported strategy sources, unknown schema versions, missing v2 identities, legacy writes from the upgraded market producer, and any attempt to route `maker_replay` through the live spool or `hb_runtime` through the replay direct path.

#### Scenario: Both profiles are evaluated
- **WHEN** a candidate provides native replay and production-compatible evidence
- **THEN** each result MUST independently prove its expected broker participation, source, HTTP acknowledgement, persistence path, and queried tables
- **AND** passing one profile MUST NOT imply the other passed

#### Scenario: Ownership boundary is crossed
- **WHEN** a producer, sidecar component, or test adapter performs work assigned to another service or repository and thereby bypasses a required boundary
- **THEN** verification MUST fail with the skipped boundary identified
- **AND** the bypassed result MUST not count toward release evidence

### Requirement: Deterministic cross-service evidence replaces production soak for this change

Completion of this capability SHALL require the pinned Local lifecycle, real ClickHouse 24.8 A/B migration, CEX sidecar verification, and Maker `develop` conformance evidence. It MUST NOT require a production-soak task, live venue credentials, real-asset movement, or production trading.

#### Scenario: Deterministic evidence is complete
- **WHEN** all required CEX and Maker jobs pass at recorded commits and their manifests agree
- **THEN** the implementation tasks for this change MAY be marked complete and prepared for OpenSpec sync/archive
- **AND** any separate production observation ticket MUST remain independent of this definition of done

#### Scenario: Production soak has not run
- **WHEN** deterministic conformance is complete but no production observation exists
- **THEN** the absence of soak MUST NOT block this change's completion
- **AND** the evidence MUST not claim that deterministic CI constitutes production observation
