# Archive E2E regression

The required archive E2E suite uses an immutable pre-canonical fixture and a
separate pinned ClickHouse Local runtime. Normal test and CI runs consume the
committed fixture and never fetch or execute historical Git revisions.

## Baseline provenance and regeneration

The baseline is `64fdf0607a234be05bac98f3edd3125e2c05d083`, whose runtime
parent is `d20daf895616cdce1cff65a8191c0bb937583c6a`. The canonical runtime
prerequisite is `2730a00a0fcd6cbafbcb03cb432fa7f4224d269a`.

Regeneration is intentionally narrower than normal development. Use:

```sh
bun run scripts/generate-archive-e2e-baseline.ts
```

The command requires Linux x64, Bun 1.3.12, the committed `bun.lock`, and a
clean Git object containing the baseline commit. It exports the historical tree
to a temporary directory, copies only the committed deterministic input and
generation driver into that export, executes the historical row builders there,
records all source/input/toolchain hashes, and removes the export automatically.
It does not import current runtime builders into the historical process.

Verify the committed fixture without rewriting it:

```sh
bun run scripts/generate-archive-e2e-baseline.ts --check
```

A baseline update requires a separate compatibility OpenSpec, an explicit new
baseline commit, and review of every projection and row difference. Additive
current schema columns or canonical outputs never justify regenerating the
legacy fixture.

## ClickHouse Local boundary

The Local suite is pinned to ClickHouse `v25.8.24.21-lts`. It executes the
production schema manifest, storage engines, tables, and views, but it does not
exercise the production `@clickhouse/client` HTTP transport. The existing
server-backed integration suite remains responsible for that network boundary.

Run the required suite with:

```sh
bun run test:e2e:archive
```

The command selects only `e2e/archive/archive.e2e.ts`, serializes tests, and
fails if the file is absent, no test is discovered, the binary cannot be
verified, or schema initialization fails. `bun run test` selects the `test/`
tree and therefore remains the separate unit/server-integration command.

On Linux x64 and arm64, the harness downloads the official pinned static
archive into `.cache/clickhouse-local`, verifies the committed SHA-512 digest,
extracts only the ClickHouse binary, and verifies its reported four-part
version. CI caches that directory using the version-and-digest cache key. To
use a pre-provisioned binary, set `CLICKHOUSE_LOCAL_BIN` to an executable that
reports exactly `25.8.24.21`; an absent, non-executable, or differently versioned
override is a hard failure. `CLICKHOUSE_LOCAL_CACHE_DIR` may relocate the
verified cache.

Each test owns a unique temporary persistent `--path` database, applies every
file from the production archive schema manifest, and serializes Local CLI
operations. Cleanup terminates owned processes and removes only that temporary
directory. On failure, diagnostics name the schema file and statement, table,
feed, barrier, or stored checksum that failed; there is no conditional skip.

The deterministic lifecycle always provisions archive enablement, a local
authenticated `/archive` endpoint, a unique writable loss journal, fixed
deployment and capture-bundle identities, and the canonical `broker_read`
source before releasing frames. The runtime lifecycle has no write-mode or
credential-policy axis. Compatibility for all 15 historical tables is tested
separately by replaying the immutable fixture through the production HTTP
parser, validator, router, inserter, and query-back path.

The suite also contains a permanent source-surface regression check. It fails
if removed write-mode, credential-policy, credential-profile, attestation, or
smoke-secret controls return to executable code, workflows, or operator docs.

## FIET-1014 CEX Proof A

The ORDERBOOK gate uses the production `MarketDataCollector` and the same
five-observation depth-100 tape for conservative and explicitly candidate-enabled
Binance/MEXC compositions. Bid and ask quantities change materially across the
tape. The gate compares ordered logical payloads, canonical archive outcomes,
price-band coverage, ClickHouse-rehydrated inputs, and physical work, while a
separate 25-level case must fail replay sufficiency. It exports CEX input facts
only; Layer 12 policy outputs belong to FIET Maker Proof B.

Generate the deterministic pack with:

```sh
bun run archive:proof-a -- /absolute/path/cex-orderbook-coalescing-evidence.json
```

The file is `canonicalSerialize` UTF-8 JSON followed by exactly one LF. SHA-256
is computed over the complete file bytes; the document has no self-hash or
run/host/path/time metadata. The active change includes a generated sample for
the Maker handshake. Candidate profiles remain disabled in ordinary runtime
configuration regardless of whether this evidence file exists.

## Canonical-upgrade baseline and A/B acceptance

The immutable canonical-upgrade baseline derived from the authoritative
`develop` branch is maintained separately from the historical compatibility
fixture above. Generate it only from the exact clean baseline checkout and
verify it without rewriting expectations:

```sh
bun run archive:baseline:generate
bun run archive:baseline:verify
```

The current accepted baseline is commit
`7a83de5f29a08f42d81f64a75a83bc9318dce94a`, package `0.2.38`. Both authoritative
remotes must resolve `develop` to that commit during generation. The committed
manifest records exact DDL, table projections, ordering, deterministic data,
tool versions, source hashes, and the fixture-derived half-open migration window.

After the final candidate is committed and clean, run the one-time Server 24.8
A/B acceptance outside ordinary CI:

```sh
bun run test:acceptance:archive-upgrade
```

The runner starts isolated A and B servers from that identical fixture. A
remains unchanged. B receives the production schema initializer, confirmed
database-to-database migration over the recorded window, parameter-bound
cutover checks, an idempotent second migration, and upgraded four-feed capture
through the normal broker/collector/forwarder transport. A failure retains
stopped databases and a bounded diagnostic manifest; inspect it before removing
the named containers. Success removes both containers and writes the acceptance
JSON below the active OpenSpec change. This fixed upgrade acceptance is not a
recurring CI job; `test:e2e:archive` remains the generalized continuous archive
regression.

## Live credentialless public smoke

The non-gating smoke is available only through its scheduled/manual workflow or
an explicit operator invocation:

```sh
bun run test:smoke:archive
```

It requires no exchange credentials. Optional `CEX_BROKER_SMOKE_EXCHANGE` and
`CEX_BROKER_SMOKE_SYMBOL` default to `binance` and `BTC/USDT`. The Subscribe
handler constructs a credentialless public exchange client only after the
operation guard has accepted the fixed feed inventory.

Before connecting, a fail-closed operation guard requires exactly the public
ORDERBOOK, TICKER, TRADES, and OHLCV Subscribe inventory and rejects
`ExecuteAction`, private/account feeds, missing feeds, or duplicates. Each feed
has a first-frame deadline, the whole run and reconnect behavior are bounded,
and cleanup deadlines cover streams, broker, writer, forwarder, and ClickHouse
Local. Success requires a raw checksum and linked normalized canonical row for
every feed. The workflow has no exchange secrets, permission attestations, or
credential-selection controls, and logs must not emit unredacted provider
payloads or secret values.
