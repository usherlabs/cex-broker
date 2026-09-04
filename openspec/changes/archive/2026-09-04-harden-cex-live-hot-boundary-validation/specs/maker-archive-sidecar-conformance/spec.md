## ADDED Requirements

### Requirement: Proof C verifies the complete producer-run row set

For each of the five strategy tables, Proof C SHALL query every row matching the exact deployment, `hb_runtime` source, schema version, producer ID, producer run ID, and positive sequence contract. The complete persisted `archive_event_id` set and count SHALL equal the Maker-declared set and manifest expectation. The Maker result `delivery.batchId` SHALL equal the sidecar run/batch identity.

#### Scenario: Expected rows land with no extras

- **WHEN** each strategy table contains exactly its declared producer-run row IDs
- **THEN** Proof C SHALL accept the five-table persistence evidence

#### Scenario: Extra or stale producer-run row exists

- **WHEN** any strategy table contains an additional row matching the producer/run predicate but absent from Maker evidence
- **THEN** Proof C SHALL fail and report the expected and observed identity sets

#### Scenario: Delivery batch identity differs

- **WHEN** the Maker result declares a batch ID other than the manifest run/batch identity
- **THEN** result validation SHALL fail before querying persistence
