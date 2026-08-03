## Historical apply-phase RED evidence — superseded

This evidence predates the canonical-only configuration amendment. It remains as implementation history but does not satisfy amended tasks 3.7 or 3.9 because it expected obsolete dual-write and credential-policy behavior. Fresh behavioral RED evidence is required before removing those surfaces during the next apply phase.

- Captured: 2026-08-03 UTC
- Command: `bun run test:e2e:archive`
- Runtime prerequisite: checksum-pinned ClickHouse Local `25.8.24.21` from the committed linux-amd64 artifact cache, verified successfully before test setup
- Discovery: 9 tests discovered and executed; command exited 1 with 9 failures and no skips
- Behavioral failures:
  - three runtime/storage scenarios reached the compileable `ClickHouseLocalHarness` contract and failed with `ClickHouseLocalHarness storage behavior is not implemented`;
  - dual and canonical lifecycle scenarios failed with `production four-feed archive lifecycle is not implemented`;
  - order-book duplicate/conflict coverage failed with `order-book conflict regression is not implemented`; and
  - blocked, recoverable, and terminal sink scenarios failed at their corresponding unimplemented composed lifecycle behaviors.

This is acceptable behavioral RED evidence: test discovery, fixture imports, exact binary verification, and test setup succeeded. No failure was attributed to a missing import, missing fixture, unavailable or wrong-version binary, schema/archive misconfiguration, conditional skip, or pass-with-no-tests path.
