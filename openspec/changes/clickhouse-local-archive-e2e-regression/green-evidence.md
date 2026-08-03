# Historical apply-phase GREEN evidence — superseded

These results predate the canonical-only configuration amendment and do not establish conformance with corrected prerequisite commit `2730a00a0fcd6cbafbcb03cb432fa7f4224d269a`. They remain as implementation history; amended task 10.8 requires fresh GREEN evidence after obsolete write-mode, credential-policy, profile, and attestation behavior is removed.

Recorded 2026-08-03 UTC after the canonical runtime prerequisite was integrated.

- Baseline regeneration: `bun run scripts/generate-archive-e2e-baseline.ts --check` passed twice. The resulting fixture SHA-256 is `560e7fb5f38047d155d49c1df68aa3d158ffe37760935feb3bb11cbb3b4f8a66`.
- Required E2E: `bun run test:e2e:archive` passed 9/9 tests with 50 assertions against ClickHouse Local `25.8.24.21`.
- History/download independence: the same E2E command passed 9/9 from a source-only temporary export with no Git metadata or local cache directory, using only the committed fixture and an exact-version `CLICKHOUSE_LOCAL_BIN` override. The temporary export was moved to the system trash after the run.
- Normal tests: `bun run test` passed 561/561 tests with 1,564 assertions. The archive `.e2e.ts` runner remained outside this command.
- Canonical fixture: the stream/ticker/trade expected checksums were updated only to reflect the added production-compatible legacy fields and Decimal(18,8) pre-checksum normalization; the immutable legacy baseline projections and expected rows were not weakened.
- Static/build validation: `bun run check`, `bun run check:server-lines`, `bun run build:ts`, and `bun run build` passed. Biome reports existing warnings but no errors. `src/server.ts` remains 65 lines and no protobuf source or generated descriptor diff remains.
- OpenSpec: `openspec validate clickhouse-local-archive-e2e-regression --strict` passed. The canonical prerequisite OpenSpec has no diff.
- Server-backed integration boundary: `bun test test/clickhouse-schema.integration.test.ts` completed 10/10 tests, but no provisioned ClickHouse server environment was present and the initial transport probe received `ECONNREFUSED`; the retained suite remains the CI/operator-owned `@clickhouse/client` transport boundary.
- Live smoke: the pre-amendment operation guard passed 2/2 tests and the scheduled/manual workflow was installed. No live run was executed; this result is superseded by the credentialless public-smoke requirements.

Expected warning/error logs in the required E2E are produced only by the deliberate source-rejection, checksum-conflict, recoverable-inserter-failure, and terminal-inserter-failure scenarios; all corresponding assertions passed.
