## ADDED Requirements

### Requirement: The published subpath exposes the complete final-v1 library boundary
The dedicated package subpath SHALL export strict request/result codecs, schema
and policy manifests, RFC 8785 identity helpers, the domain runner, and a
dependency factory. Its implementation and generated declarations MUST NOT
import broker/server modules. Schemas, policies, fixtures, and declarations
MUST be present in the published npm tarball.

#### Scenario: Fiet TEE bundles the subpath
- **WHEN** a consumer imports or bundles the package subpath
- **THEN** it MUST obtain all final-v1 artifacts without starting the gRPC server
- **AND** package smoke tests MUST reject server-side imports or missing assets

### Requirement: Market-data vendor backfill is a bounded archive tool
The service architecture SHALL document `market-data-vendor-backfill` as a
bounded library/tool executed by a caller-owned preparation process. CEX Broker
MUST own reusable provider adapters, canonicalization, forwarder submission,
qualified archive preflight, and promotion verification. The tool MUST have
provider-read, qualified-archive-read, and archive-forwarder-write access but no
direct ClickHouse write authority. Fiet TEE MAY own a bundled executable and
secure-secret wrapper without duplicating the core data logic.

#### Scenario: Reader locates the worker boundary
- **WHEN** an operator compares the worker with the broker, collector, and
  archive-forwarder
- **THEN** the architecture MUST state that the worker is not an always-on
  service, broker RPC/action, collector responsibility, or vendor-fetch feature
  of the forwarder
- **AND** it MUST state that only the forwarder owns ClickHouse writes

#### Scenario: Forwarder durability ownership is inspected
- **WHEN** an operator evaluates a failed market-data backfill submission
- **THEN** documentation MUST assign bounded deterministic retry and resubmission
  to the worker producer
- **AND** it MUST NOT claim that the strategy-runtime SQLite spool owns vendor
  market-data batches

### Requirement: Cross-repository backfill proof ownership is explicit
The architecture SHALL assign CEX Broker ownership of the promotion receipt and
CEX canonical-export compatibility, Fiet TEE ownership of the pinned executable
and secret/file boundary, and Fiet Maker ownership of independent post-promotion
archive re-query, actual loader consumption, final artifact construction, and
policy proof.

#### Scenario: FIET-1017 evidence is assembled
- **WHEN** a cross-repository gate verifies promoted vendor-origin history
- **THEN** it MUST bind the published CEX package, Fiet TEE executable, CEX
  promotion receipt, Maker post-promotion query, and Maker consumer artifact
- **AND** CEX Broker MUST NOT import or invoke Maker application or policy code
