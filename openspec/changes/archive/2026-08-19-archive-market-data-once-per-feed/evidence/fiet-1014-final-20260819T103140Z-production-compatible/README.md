# FIET-1014 final production-compatible evidence

This directory retains the accepted same-run CEX Proof A, Maker Proof B, and
CEX-local Proof C for `archive-market-data-once-per-feed`.

## Immutable inputs

- Run ID: `fiet-1014-final-20260819T103140Z-production-compatible`
- CEX candidate: `da1dd5282e899448b82bca858bbe2d6d824f167e`
- Maker develop: `be91c208662daf46fa6767b133b08fe317f39809`
- Profile: `production_compatible`
- Proof A SHA-256: `aee0c8c5795fd12401d3eff1c5cc0f59ffe8f2559cde6ba4432578bf22dccba0`
- Proof B SHA-256: `cf0bdcd5fb46576e09394189ab8a0997f095f595553412eaeee32bca486a3007`
- Maker policy configuration SHA-256:
  `f3deacb076a55dbefdf4ed63657df1e8730628a7d7d80a4b4f62cd06b8df0edf`

Both repositories were clean before the accepted run. The CEX checkout was
detached at the candidate SHA; Maker was on `develop` with
`HEAD == origin/develop`.

## Candidate certification

The following commands were run from the detached CEX candidate, with their
logs captured outside the worktree before the retained E2E log was copied here:

```sh
bun test test
bun run build:ts
bunx biome check .
bun run test:e2e:archive
```

Outcomes:

- `bun test test`: 750 passed, 0 failed.
- `bun run build:ts`: passed.
- `bunx biome check .`: exited 0 with the repository's existing 113 warnings.
- `bun run test:e2e:archive`: 18 passed, 0 failed.
- The archive E2E suite passed `runtime spool survives restart and retries only
  the failed table`, proving stable table-level deduplication after restart.
- The same E2E run passed separate Binance and MEXC conservative-versus-candidate
  gates, archive replay sufficiency, and depth-25 rejection.

## Same-run proof command

From the clean Maker `develop` checkout:

```sh
bash scripts/sandbox/run-cex-sidecar-conformance.sh \
  --cex-repo /home/azureuser/.config/superpowers/worktrees/cex-broker/fiet-1014-candidate-da1dd52 \
  --candidate-sha da1dd5282e899448b82bca858bbe2d6d824f167e \
  --profile production_compatible \
  --run-id fiet-1014-final-20260819T103140Z \
  --artifacts-dir /home/azureuser/.config/superpowers/worktrees/cex-broker/fiet-1014-candidate-da1dd52/openspec/changes/archive-market-data-once-per-feed/evidence
```

`verification.json` reports `status: passed` and binds both repository SHAs.
Proof A contains five distinct observations for each of Binance and MEXC, all
five CEX verdicts pass, and each venue rejects the 25-level replay. Proof B has
five evaluations over four isolated controller streams per venue, ten passing
negative controls, and binds its source hash to the exact retained Proof A
bytes. Proof C records one collector plus one Maker logical subscription over
one physical worker; archive decisions equal physical frames; strategy
delivery received HTTP 202; queued and terminal spool work are zero; and all
six market plus five strategy tables contain positive identity-correct rows.

Every declared artifact hash and the policy configuration hash were recomputed
from retained bytes. Teardown removed the run-owned ClickHouse container,
producer-access file, SQLite spool, WAL, and SHM files.

A preceding run against the superseded CEX candidate failed closed on a stale
Maker wire-fixture pin. That run was rejected, its resources were torn down,
the pin and regression test were merged, and certification restarted from the
new candidate SHA recorded above.

Passing this evidence does not activate Binance or MEXC coalesced profiles.
Activation remains owned by `activate-binance-mexc-coalesced-orderbook-profiles`.

`SHA256SUMS` covers every retained file in this directory except itself.
