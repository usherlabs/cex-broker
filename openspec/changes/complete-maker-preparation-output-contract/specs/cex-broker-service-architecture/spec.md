## MODIFIED Requirements

### Requirement: The published subpath exposes the complete final-v1 library boundary
The dedicated package subpath SHALL export the current request/result codecs,
schema and policy manifests, RFC 8785 identity helpers, domain runner,
dependency factory, qualification-observer interfaces, contextual required-clock
qualification, and the closed `market-data-source-tape/v1` policy-neutral
source-tape preparation API. Its implementation
and generated declarations MUST NOT import broker/server or Maker modules. Current
schemas, policies, fixtures, declarations, both standalone preparation
executables, the two Parquet projection schemas, and the forensic-ledger and
qualification-record schemas MUST be present in the published npm tarball.
Previous policy versions MUST NOT remain executable dispatch choices in that
boundary. Product pin v2 MUST bind the source-tape exported subpath, runtime and
declaration hashes, and role-neutral source-tape capability policy separately
from its exactly two executable identities.

#### Scenario: Maker verifies the package boundary
- **WHEN** Maker audits and extracts the pinned registry package
- **THEN** it MUST obtain all current preparation artifacts, both executable entrypoints, and the role-neutral source-tape package-library operation without starting the gRPC server
- **AND** package smoke tests MUST reproduce the library and capability pins and reject server-side imports, missing assets, external runtime dependencies, informal invocation/result documents, or live legacy policy dispatch

### Requirement: Market-data vendor backfill is a bounded archive tool
The service architecture SHALL document `market-data-vendor-backfill` and
`cex-canonical-orderbook-export` as CEX-owned bounded preparation file jobs, not
long-running services. CEX Broker MUST own their file/CLI boundaries, provider
adapters, canonicalization, source qualification, forwarder submission,
qualified archive preflight, promotion verification, exact export, packaging,
and release pins. The qualification observer and policy-neutral source-tape
runner SHALL be exported through the server-independent package-library
boundary, not a third executable or a Maker-policy request mode. A Maker-owned
shim MAY invoke that package operation in a local process or sidecar, but CEX
MUST continue to own provider, reconstruction, qualification, and forwarder
submission behavior. The library invocation MUST be pair/window-scoped and
required-clock-independent, and its operation-specific qualification-record-v1
branch MUST be the pair-local terminal commit marker.

The backfill file job MUST have provider-read, qualified-archive-read, and
archive-forwarder-write access but no direct ClickHouse write authority. The
exporter MUST have qualified-archive-read access only and MUST NOT receive
provider credentials or archive-forwarder-write authority. Fiet TEE MUST NOT be
a build, executable, wrapper, release, gitlink, provenance, or runtime
dependency of either product.

The policy-neutral source-tape operation SHALL use a disposable local
ClickHouse and forwarder whose target identity is exactly
`sandbox/cex-archive-local`. The forwarder's stable `production` scope SHALL be
treated only as the existing mutation-authorization class; it MUST NOT be
interpreted as the target environment and MUST NOT be weakened for sandbox
execution. The harness SHALL send the request's exact authorization ID,
environment, and cluster on preflight.

#### Scenario: Reader locates the preparation boundary
- **WHEN** an operator compares the file jobs with the broker, collector, archive-forwarder, Maker, and Fiet TEE
- **THEN** the architecture MUST state that neither file job is an always-on service, broker RPC/action, collector responsibility, vendor-fetch feature of the forwarder, or Fiet TEE executable
- **AND** it MUST state that only the forwarder owns ClickHouse writes and Maker invokes the pinned CEX executables or server-independent package-library operation

#### Scenario: Maker launches one local preparation workflow
- **WHEN** Maker supervises the source-tape operation beside its emulator in a closed Node process or Docker sidecar
- **THEN** CEX provider acquisition, venue reconstruction, source forensics, archive admission, promotion, selection, and export MUST execute from the pinned CEX package
- **AND** process placement beside Maker MUST NOT grant Maker direct `market_data` write authority or transfer source qualification ownership

#### Scenario: Reader inspects exporter authority
- **WHEN** an operator inspects credentials and network access for `cex-canonical-orderbook-export`
- **THEN** the exporter MUST have qualified-archive-read access only
- **AND** it MUST NOT obtain provider-read, forwarder-write, or direct ClickHouse-write authority

#### Scenario: Forwarder durability ownership is inspected
- **WHEN** an operator evaluates a failed market-data backfill submission
- **THEN** documentation MUST assign bounded deterministic retry and resubmission to the CEX backfill producer
- **AND** it MUST NOT claim that the strategy-runtime SQLite spool owns vendor market-data batches

### Requirement: Cross-repository backfill proof ownership is explicit
The architecture SHALL assign CEX Broker ownership of both packaged preparation
executables, their immutable registry release and product pin, current-policy
promotion receipts, exact selections, canonical exports, projection schemas,
and pair-local CEX qualification evidence. Fiet Maker SHALL own verified package
resolution, bounded process invocation, the cross-stage preparation state
machine, Candidate A/B/C roles, DEX and scheduler inputs, policy-clock and
admitted-clock derivation, capacity preflight, target-to-invocation mapping,
`reference_depth_stale`, independent post-promotion archive re-query, actual
loader consumption, final artifact construction, pair aggregation, and policy
proof. CEX Broker MUST NOT validate a Maker derivation descriptor as policy
authority or produce an atomic multi-pair thesis verdict. Fiet TEE SHALL own none of the build,
executable, release, wrapper, runtime, or provenance boundary.

#### Scenario: FIET-1017 evidence is assembled
- **WHEN** a cross-repository gate verifies promoted vendor-origin history
- **THEN** it MUST bind the published CEX registry package and product pin, current CEX promotion receipts, exact selections and export results, Maker post-promotion query, and Maker consumer artifact
- **AND** CEX Broker MUST NOT import or invoke Maker application or policy code

#### Scenario: CEX receives a required clock
- **WHEN** Maker submits a bootstrap, nominal, or admitted policy clock through the generic required-clock schema
- **THEN** CEX MUST validate the exact clock and source evidence without interpreting its Maker-owned role
- **AND** Candidate labels, Maker scheduler/configuration fingerprints, DEX hashes, invocation mappings, and blocked runtime outcomes MUST NOT become CEX qualification selectors

#### Scenario: A dual-pair thesis run is coordinated
- **WHEN** ARB-USDT and ARB-USDC are prepared for one Maker run
- **THEN** CEX MUST commit one durable result per pair and keep their artifacts path-distinct
- **AND** Maker MUST own cross-pair ordering, retained partial evidence, and the atomic aggregate verdict
