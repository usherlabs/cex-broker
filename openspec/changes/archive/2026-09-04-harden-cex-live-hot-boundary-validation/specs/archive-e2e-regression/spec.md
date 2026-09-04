## ADDED Requirements

### Requirement: Archive regression covers hardening boundaries

The archive regression suite SHALL cover blank deployment configuration, per-row deployment mismatch, bounded measurement bands, upgraded supported-view type parity, and complete Proof C producer-run row-set behavior at their owning test layers.

#### Scenario: Hardening regression runs

- **WHEN** required qualification executes
- **THEN** each accepted review boundary SHALL have a positive and negative test
- **AND** strict OpenSpec and archive E2E gates SHALL remain passing
