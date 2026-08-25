## MODIFIED Requirements

### Requirement: The published subpath exposes the complete final-v1 library boundary
The dedicated package subpath SHALL export the current request/result codecs,
schema and policy manifests, RFC 8785 identity helpers, domain runner,
dependency factory, and qualification-observer interfaces. Its implementation
and generated declarations MUST NOT import broker/server modules. Current
schemas, policies, fixtures, declarations, both standalone preparation
executables, the two Parquet projection schemas, and the forensic-ledger and
qualification-record schemas MUST be present in the published npm tarball.
Previous policy versions MUST NOT remain executable dispatch choices in that
boundary.

#### Scenario: Maker verifies the package boundary
- **WHEN** Maker audits and extracts the pinned registry package
- **THEN** it MUST obtain all current preparation artifacts and both executable entrypoints without starting the gRPC server
- **AND** package smoke tests MUST reject server-side imports, missing assets, external runtime dependencies, or live legacy policy dispatch

### Requirement: Market-data vendor backfill is a bounded archive tool
The service architecture SHALL document `market-data-vendor-backfill` and
`cex-canonical-orderbook-export` as CEX-owned bounded preparation file jobs, not
long-running services. CEX Broker MUST own their file/CLI boundaries, provider
adapters, canonicalization, source qualification, forwarder submission,
qualified archive preflight, promotion verification, exact export, packaging,
and release pins. The qualification observer SHALL be a library used by the CEX
qualification harness, not a third executable or a Maker request mode.

The backfill file job MUST have provider-read, qualified-archive-read, and
archive-forwarder-write access but no direct ClickHouse write authority. The
exporter MUST have qualified-archive-read access only and MUST NOT receive
provider credentials or archive-forwarder-write authority. Fiet TEE MUST NOT be
a build, executable, wrapper, release, gitlink, provenance, or runtime
dependency of either product.

#### Scenario: Reader locates the preparation boundary
- **WHEN** an operator compares the file jobs with the broker, collector, archive-forwarder, Maker, and Fiet TEE
- **THEN** the architecture MUST state that neither file job is an always-on service, broker RPC/action, collector responsibility, vendor-fetch feature of the forwarder, or Fiet TEE executable
- **AND** it MUST state that only the forwarder owns ClickHouse writes and Maker directly invokes the pinned CEX executables

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
and CEX qualification evidence. Fiet Maker SHALL own verified package
resolution, bounded process invocation, independent post-promotion archive
re-query, actual loader consumption, final artifact construction, pair
aggregation, and policy proof. Fiet TEE SHALL own none of the build,
executable, release, wrapper, runtime, or provenance boundary.

#### Scenario: FIET-1017 evidence is assembled
- **WHEN** a cross-repository gate verifies promoted vendor-origin history
- **THEN** it MUST bind the published CEX registry package and product pin, current CEX promotion receipts, exact selections and export results, Maker post-promotion query, and Maker consumer artifact
- **AND** CEX Broker MUST NOT import or invoke Maker application or policy code
