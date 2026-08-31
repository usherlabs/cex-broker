## ADDED Requirements

### Requirement: Service image smoke is time bounded

The archive-forwarder image smoke SHALL probe health from inside the container with a per-attempt timeout and SHALL retain bounded total attempts and cleanup.

#### Scenario: Health endpoint accepts but does not complete

- **WHEN** an in-container health request hangs
- **THEN** that attempt SHALL abort within two seconds
- **AND** the smoke loop SHALL continue or fail within its bounded deadline while cleanup remains active
