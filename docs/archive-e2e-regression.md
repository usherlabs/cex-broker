# Archive E2E regression

The required archive E2E suite uses an immutable pre-canonical fixture and a
separate pinned ClickHouse Local runtime. Normal test and CI runs consume the
committed fixture and never fetch or execute historical Git revisions.

## Baseline provenance and regeneration

The baseline is `64fdf0607a234be05bac98f3edd3125e2c05d083`, whose runtime
parent is `d20daf895616cdce1cff65a8191c0bb937583c6a`. The canonical runtime
prerequisite is `d018a386b55058bccb71b0feb4ea21358b8bd8d9`.

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
deployment and capture-bundle identities, and explicit source/write-mode axes
before releasing frames. The required matrix is `broker_write`/`dual` and
`broker_read`/`canonical`; pure legacy mode is intentionally outside it.

## Live read-only smoke

The non-gating smoke is available only through its scheduled/manual workflow or
an explicit operator invocation:

```sh
bun run test:smoke:archive
```

It requires `CEX_BROKER_SMOKE_READ_ONLY_ATTESTED=true`,
`CEX_BROKER_SMOKE_API_KEY`, `CEX_BROKER_SMOKE_API_SECRET`, a valid
`CEX_BROKER_CREDENTIAL_ATTESTATION_KIND`, and a non-empty
`CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE`. Optional
`CEX_BROKER_SMOKE_EXCHANGE` and `CEX_BROKER_SMOKE_SYMBOL` default to `binance`
and `BTC/USDT`. The operator must verify out of band that the key cannot trade,
cancel, transfer, deposit, withdraw, or move assets; the smoke never probes
those permissions.

Before connecting, a fail-closed operation guard requires exactly the public
ORDERBOOK, TICKER, TRADES, and OHLCV Subscribe inventory and rejects
`ExecuteAction`, private/account feeds, missing feeds, or duplicates. Each feed
has a first-frame deadline, the whole run and reconnect behavior are bounded,
and cleanup deadlines cover streams, broker, writer, forwarder, and ClickHouse
Local. Success requires a raw checksum and linked normalized canonical row for
every feed. Secret values are not placed in artifacts and top-level errors are
redacted against the provisioned credentials.
