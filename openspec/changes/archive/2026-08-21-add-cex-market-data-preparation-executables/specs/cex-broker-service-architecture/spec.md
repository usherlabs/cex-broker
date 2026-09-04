## MODIFIED Requirements

### Requirement: Market-data vendor backfill is a bounded archive tool
The service architecture SHALL document `market-data-vendor-backfill` and
`cex-canonical-orderbook-export` as CEX-owned bounded preparation executables,
not long-running services. CEX Broker MUST own their file/CLI boundaries,
provider adapters, canonicalization, forwarder submission, qualified archive
preflight, promotion verification, exact export, packaging, and release pins.
The backfill tool MUST have provider-read, qualified-archive-read, and
archive-forwarder-write access but no direct ClickHouse write authority; the
exporter MUST have qualified-archive-read access only. Fiet TEE MUST NOT own or
wrap either product.

#### Scenario: Reader locates the preparation boundary
- **WHEN** an operator compares the commands with the broker, collector, and archive-forwarder
- **THEN** the architecture MUST state that neither command is an always-on service, broker RPC/action, collector responsibility, or vendor-fetch feature of the forwarder
- **AND** it MUST state that only the forwarder owns ClickHouse writes

#### Scenario: Forwarder durability ownership is inspected
- **WHEN** an operator evaluates a failed market-data backfill submission
- **THEN** documentation MUST assign bounded deterministic retry and resubmission to the backfill producer
- **AND** it MUST NOT claim that the strategy-runtime SQLite spool owns vendor market-data batches

### Requirement: Cross-repository backfill proof ownership is explicit
The architecture SHALL assign CEX Broker ownership of both packaged preparation
executables, the promotion receipt, exact canonical export, and immutable npm
product pin. Fiet Maker SHALL own archive-first dispatch, independent
post-promotion archive re-query, actual loader consumption, final artifact
construction, required-clock proof, and policy proof. Fiet TEE SHALL have no
ownership in this preparation path.

#### Scenario: FIET-1017 evidence is assembled
- **WHEN** a cross-repository gate verifies promoted vendor-origin history
- **THEN** it MUST bind the published CEX tarball and executable identities, CEX promotion receipt and exact export, Maker post-promotion query, and Maker consumer artifact
- **AND** CEX Broker MUST NOT import or invoke Maker application or policy code
