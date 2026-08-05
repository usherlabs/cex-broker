## Canonical-only configuration amendment RED evidence

- Captured: 2026-08-03 UTC
- Command: `bun run test:e2e:archive`
- Runtime prerequisite: checksum-pinned ClickHouse Local `25.8.24.21` initialized successfully with the production schema
- Discovery: 10 tests discovered and executed; command exited 1 with 9 passes, 1 failure, and no skips
- Behavioral failure: `removed archive and credential configuration remains absent` found 236 forbidden references across production code, handlers, E2E support, tests, migration SQL, operational documentation, the live-smoke script, and its workflow
- Control result: all existing ClickHouse storage, all-table compatibility, dual/canonical lifecycle, conflict, blocked-sink, recoverable-failure, and terminal-journal scenarios passed

This is acceptable amendment RED evidence because the exact pinned binary, fixture imports, schema initialization, HTTP topology, ClickHouse queries, and test discovery succeeded. The only failing assertion was the newly added configuration-surface contract, demonstrating the obsolete runtime and smoke configuration before integrating corrected prerequisite commit `2730a00` and adapting the E2E implementation.

## Historical initial apply-phase RED evidence

- Captured: 2026-08-03 UTC
- Command: `bun run test:e2e:archive`
- Runtime prerequisite: checksum-pinned ClickHouse Local `25.8.24.21` from the committed linux-amd64 artifact cache, verified successfully before test setup
- Discovery: 9 tests discovered and executed; command exited 1 with 9 failures and no skips
- Behavioral failures:
  - three runtime/storage scenarios reached the compileable `ClickHouseLocalHarness` contract and failed with `ClickHouseLocalHarness storage behavior is not implemented`;
  - dual and canonical lifecycle scenarios failed with `production four-feed archive lifecycle is not implemented`;
  - order-book duplicate/conflict coverage failed with `order-book conflict regression is not implemented`; and
  - blocked, recoverable, and terminal sink scenarios failed at their corresponding unimplemented composed lifecycle behaviors.

This historical evidence predates the canonical-only amendment. It remains as implementation history but does not replace the amendment RED evidence above.
