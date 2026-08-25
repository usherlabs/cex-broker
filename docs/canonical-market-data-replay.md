# Canonical CEX market-data replay archive

This is the deployment and operations contract for the CEX-broker portions of FIET-901 and FIET-903. FIET-903's broker RPC/capability/current-snapshot/live-stream sub-scope was completed by `cex-broker-order-book-depth-sourcing`; this change adds capture, storage, migration, and replay integrity. It does not add or gate RPCs.

## Deployment identity and credential precedence

TEE and non-TEE deployments run the same broker binary and register the full `ExecuteAction` and `Subscribe` service. Archive role does not reduce that service surface.

Set the deployment-owned archive identity:

```env
CEX_BROKER_ARCHIVE_ENABLED=true
CEX_BROKER_ARCHIVE_SOURCE=broker_read
CEX_BROKER_DEPLOYMENT_ID=market-reader-eu-1
CEX_BROKER_CAPTURE_BUNDLE_ID=cex-2026-08-03-eu-1
CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=production
CEX_BROKER_ARCHIVE_FORWARDER_URL=http://archive-forwarder:8090/archive
CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH=/var/lib/cex-broker/archive-loss.jsonl
```

`CEX_BROKER_ARCHIVE_SOURCE` is closed to `broker_read|broker_write` and defaults to `broker_write` for existing deployments. The writer stamps this immutable value into envelopes, rows, and loss records. It is never inferred from API-key presence. FIET-901 deployment verification requires the separately deployed broker to use `broker_read`, an explicit deployment ID, and a non-empty deployment-owned capture bundle before continuous capture is declared ready; the core broker does not infer that role or gate its RPC service. If archival is absent or disabled, archive work is a no-op. If an enabled writer lacks complete production market provenance, canonical market archival is skipped with a bounded warning while broker RPCs and stream delivery continue. Development capture explicitly uses `CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT=development` and generates a `development:<deployment>` bundle when none is supplied.

Credential resolution uses the broker's established fixed precedence and requires no archive-specific credential configuration:

1. Use a matching broker account loaded from `.env`/deployment configuration.
2. If no matching environment broker exists, use a complete request `api-key` and `api-secret` pair.
3. If neither source exists, construct a credentialless exchange only for operations that already support public access.

When environment and request credentials are both present, the environment-loaded broker wins. The broker does not classify keys as public, read-only, or write-capable and does not introduce credential-source or permission-attestation settings. For a non-TEE reader, ensure every credential that deployment or its trusted callers may supply has exchange-side trading and withdrawal permissions disabled. Those exchange permissions—not archive source or credential location—establish effective privilege.

## Four-feed collector

The collector is an independent keep-alive client of a separately deployed full broker. Set its broker target and point its canonical configuration at a JSON document containing only feed intent:

```env
CEX_BROKER_URL=cex-broker.internal:8086
CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG=/etc/cex-broker/market-data-subscriptions.json
```

```json
{
  "subscriptions": [
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "ORDERBOOK", "depthLimit": 50 },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "TICKER" },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "TRADES" },
    { "exchange": "binance", "symbol": "BTC/USDT", "feed": "OHLCV", "timeframe": "1m", "bootstrapLimit": 100 }
  ]
}
```

Run it with `bun run start-market-data-collector`. The collector starts no loopback broker, loads no CEX credentials, sends no API-key metadata, owns no archive writer, and does not connect to ClickHouse. The remote broker resolves its environment-first credentials and, when eligible archival is configured, attaches the production environment, deployment, capture bundle, source, and integrity provenance configured in the preceding section. Collector JSON containing `environment`, `captureBundleId`, or other archive identity is rejected.

Each entry has an independent reconnect supervisor and health state. OHLCV retains bootstrap/catch-up and stamps `broker_bootstrap_fetch_v1` separately from live capture. ORDERBOOK, TICKER, and TRADES record unrecoverable gaps after reconnect rather than synthesize missing events.

The collector is the coverage/liveness subscriber, not the owner of a duplicate-prevention rule. A broker runtime owns canonical public workers and archives an accepted physical observation once before fanout. ORDERBOOK depth is first resolved to a venue acquisition profile and then projected per subscriber. Binance/MEXC 500-level profiles are candidates only: the production enabled-profile set is empty, controlled verification enables them explicitly, and evidence artifacts cannot toggle runtime behavior. Replay intended for Maker must configure archive depth at least to the policy depth (100 in the FIET-1014 gate) and still prove that retained bid/ask boundaries cross every required price band; the ordinary depth 25 is not sufficient merely because rows exist.

An external CCXT or Hummingbot fallback is an optional out-of-band producer of the shared capture contract, not a broker-collector implementation. It must declare its provider, versioned fallback source mode, reason, configured exchange, and configured pair. Cross-venue or cross-pair substitution is rejected.

## Capture and integrity contract

All canonical rows carry source, deployment, capture bundle, exchange, trading pair/source symbol, provider, feed, source mode, source/received timestamps, raw capture ID/scope, schema version, checksum algorithm, raw checksum, normalized checksum, and provenance completeness. The current versions are:

- schema: `1.0.0`
- checksum: `sha256-canonical-json-v1`
- construction: sampled top-N snapshots for live/current broker order books

Raw payloads are redacted before identity/checksum calculation. Canonical JSON sorts object keys, uses finite plain-decimal numbers, normalizes negative zero, omits undefined object values, and excludes checksum fields from their own projections. The TypeScript fixture is `test/fixtures/canonical-market-capture-v1.json`; `research/hummingbot/canonical_capture_fixture.py` is the matching Maker-side verifier.

Exact L2 is future-facing and non-blocking for this delivery. The broker reports it unsupported and never silently labels sampled evidence exact. A future exact producer must supply complete continuity proof.

## Historical vendor backfill

The public `@usherlabs/cex-broker/market-data-vendor-backfill` subpath exposes `runMarketDataVendorBackfill(request, dependencies)`. It is a bounded library API, not an RPC or always-on process. Its closed lifecycle is:

1. Validate the versioned, secret-free request before I/O and query replay-qualified coverage first.
2. Resolve an explicitly enabled provider capability before asking a secure wrapper for credentials.
3. Fetch only the authorized UTC-hour objects within file, byte, row, duration, and boundary-lookback budgets; hash and validate each object; and reconstruct prior-as-of sampled top-N books.
4. Submit content-addressed candidate chunks through the archive-forwarder, query the unqualified canonical evidence, and verify logical keys/checksums, conflicts, seams, prefix/suffix stability, future leakage, depth, construction mode, required clocks, and exporter compatibility.
5. Submit a passing promotion receipt last, then requery the qualified view. Only `already_covered` and `promoted` are successful outcomes.

Starting with `@usherlabs/cex-broker@0.2.47`, CEX Broker also owns two
standalone Node 22 file-job products:

```text
market-data-vendor-backfill run --request <path> --result <path>
cex-canonical-orderbook-export run --request <path> --result <path>
```

Both commands accept exactly those five arguments. Secrets and endpoints come
only from the exact allowlist `CLICKHOUSE_URL`, `CLICKHOUSE_USER`,
`CLICKHOUSE_PASSWORD`, `CEX_BROKER_ARCHIVE_FORWARDER_URL`,
`CEX_BROKER_ARCHIVE_FORWARDER_TOKEN`, and `CRYPTOHFTDATA_API_KEY`. The exporter
reads only the three `CLICKHOUSE_*` values; it receives neither provider-read
nor archive-forwarder-write authority. Request and sidecar files are
bounded, regular, no-follow reads in one non-symlink attempt directory; the
result is validated, file-synced, atomically renamed, and directory-synced.
Malformed argv and unsafe result targets are unhandled nonzero failures, while
closed domain outcomes commit a typed result and return zero. Neither command
starts the broker, registers an RPC, runs a collector loop, or writes directly
to ClickHouse.

Backfill result v2 identifies the CEX product/version, package version and clean
git head, actual Node runtime, and runtime SHA-256 of the extracted executable.
It deliberately contains no Fiet commit, build timestamp, or self-referential
package digest. The current package has one live capability-v3/resource-v2
request path and emits result v2 only. Result-v1 codecs, previous policy assets,
and legacy conformance behavior are not published as runtime fallbacks;
historical evidence is audited against its immutable historical package.

The canonical exporter accepts one complete archive-selection v1 document. It
compiles each selected bundle interval into a non-broad half-open predicate,
uses production archive rows before vendor rows for `fill_gaps`, and uses only
qualified vendor rows for `authoritative_window`. Archive identity, checksum
conflicts, current qualification, passing promotion receipt linkage, row
counts, and Parquet schemas are checked under the same bound segments. Export
result v2 uses product version `cex-canonical-orderbook-export/v2`. It validates
ordered capture-core columns, physical/logical types, nullability, and the
pinned levels/summary projection identities before writing either fixed
basename. A successful result containing relative names, row counts, byte
counts, artifact and projection SHA-256 values, exact query identity, and
current promotion receipts is the commit marker.

The CryptoHFTData registry is default-empty. Explicit profile injection is
required; API-key possession never enables a venue or symbol. Adapter v2 adds
the independently live-proven `CRYPTOHFTDATA_OKX_SPOT_ARBUSDT_PROFILE` and
`CRYPTOHFTDATA_OKX_SPOT_ARBUSDC_PROFILE` alongside the synthetic Binance schema
profile. The quote assets are distinct source identities; the adapter never
substitutes USDT for USDC. OKX snapshots use `final_update_id=seqId` and
`last_update_id=-1`; updates use `final_update_id=seqId` and
`last_update_id=prevSeqId`. Replay ignores an update-only prefix before the
first complete snapshot but requires every applied update to link to the current
sequence. An OKX discontinuity clears state and is retained as evidence while
the same replay scans unanchored until a later complete snapshot. A snapshot
before the next required target can re-anchor it; otherwise the full clock is
scanned before `vendor_fetch_failed/update_chain_gap` is returned with bounded
sequence and clock summaries. The pinned OKX profiles admit `fill_gaps`; MEXC, exact L2, unknown
symbols, and ambiguous timestamp or sequence semantics are rejected before
credential resolution.

Preparation products accept only the exact capability-v3/resource-v2 tuple.
Resource policy v2 has a 31-day bound and retains independent file, byte, row,
24-hour acquisition-duration, depth, and 100,000-required-event ceilings.
Historical vendor rows count as current coverage only after full reverification
appends a receipt binding the current capability, resource, adapter, and
acquisition pins; the prior receipt bytes remain immutable.

Full-window CEX qualification may inject the library-only reconstruction
observer. It adds no executable and no request field. The observer writes a
content-addressed `market-data-source-forensics-ledger/v1` plus an atomic
`market-data-source-qualification-record/v1`, capped at 100,000 records and
67,108,864 canonical JSON bytes. Overflow completes an incomplete ledger and
cannot interrupt or alter reconstruction. Ledgers contain typed gap, unanchored,
stale, future-state, and checksum-conflict evidence and classifications, never
licensed rows, response bodies, credentials, or a diagnostic replay acceptance
path.

Secrets are dependency inputs, never request fields. Provider API keys are used only to obtain a short-lived token; downloads use a bearer header. ClickHouse read credentials belong to the injected archive reader, and forwarder authentication uses an HTTP bearer header. None belongs in request/result JSON, receipt hashes, URLs, argv, logs, or retained error bodies. Deterministic `batch_id` values make bounded producer-owned retries safe; the worker does not use the live-strategy spool and never writes ClickHouse directly.

The opt-in real-provider check acquires and validates one hourly object but prints only stable identities, counts, and hashes:

```bash
CRYPTOHFTDATA_CONFORMANCE_ENABLED=1 \
CRYPTOHFTDATA_CONFORMANCE_START_MS=1787045235308 \
CRYPTOHFTDATA_CONFORMANCE_TRADING_PAIR=ARB-USDC \
CRYPTOHFTDATA_API_KEY="<injected-secret>" \
bun run test:conformance:market-data-vendor-backfill
```

Before declaring the profile ready, run the stronger local promotion gate. It
starts a disposable `clickhouse/clickhouse-server:24.8`, initializes the
production schema, submits through the real HTTP archive-forwarder, requires
`promoted` plus qualified export, then repeats the identical request and
requires `already_covered` with unchanged archive counts. The downloaded object
is decoded only in memory; the temporary database and Parquet export are removed
on completion.

```bash
MARKET_DATA_VENDOR_BACKFILL_SMOKE_ENABLED=1 \
MARKET_DATA_VENDOR_BACKFILL_SMOKE_START_MS=1787045235308 \
MARKET_DATA_VENDOR_BACKFILL_SMOKE_EVIDENCE_PATH=/tmp/market-data-vendor-backfill-smoke-evidence.json \
CRYPTOHFTDATA_API_KEY="$(vault kv get -field=CRYPTOHFTDATA_API_KEY kv/secrets)" \
bun run test:smoke:market-data-vendor-backfill
```

The evidence file is atomically replaced with mode `0600` and contains only the
closed `market-data-vendor-backfill-local-smoke/v1` projection: source and
runtime versions, request/capture/receipt identities, provider object identities
and hashes, row counts, coverage/export hashes, durations, and stable outcome
codes. It never contains credentials, bearer tokens, decoded rows, response
bodies, or ClickHouse/forwarder secrets. GitHub's manual-only
`Market Data Vendor Backfill Smoke` workflow runs the same command under the
protected `market-data-vendor-backfill-smoke` environment and retains that JSON
for 90 days. Configure the environment secret `CRYPTOHFTDATA_API_KEY` and the
approved positive-control variable
`MARKET_DATA_VENDOR_BACKFILL_SMOKE_START_MS`; the workflow has no push,
pull-request, or scheduled trigger.

The approved positive controls are OKX Spot ARB-USDT and ARB-USDC beginning at
`2026-08-18T09:27:15.308Z` (`1787045235308`). Each hourly object contains a
complete 400-level-per-side snapshot followed by a linked update chain. The
ARB-USDC proof object is
`okx_spot/2026-08-18/09/ARB-USDC_orderbook.parquet.zst`, with SHA-256
`cef5f0ca79c97af44bdfe6f428fa66bb8bbde7817d3e3b72eb91e85b69521145`.
The earlier tested Binance Spot BTC-USDT objects remain unsupported for
this gate because they contain updates without a snapshot reset; the worker
continues to reject them with `update_before_snapshot` rather than synthesize an
initial historical book.

Do not commit or publish licensed provider payloads or decoded rows. The committed fixtures are synthetic. Provider licensing and durable normalized-row retention rights remain a deployment prerequisite.

Ownership stays split across repositories: CEX Broker owns acquisition,
normalization, archive submission, semantic qualification, both preparation
executables, and their request/result contracts. Deployment automation injects
the CEX read/forwarder/provider secrets. Fiet Maker independently pins and
extracts the published package, requeries qualified views through the exporter,
and binds its loader/policy proof to the CEX receipt. Promotion or export makes
evidence eligible for replay but does not by itself make an economics result
quotable.

## ClickHouse and replay

Canonical storage is:

- `market_data.cex_stream_events` for the redacted raw ledger
- `market_data.cex_ticker_events`, `market_data.cex_trades`, and `market_data.cex_ohlcv`
- append-only `market_data.cex_order_book_levels` and `market_data.cex_order_book_depth_summary`
- append-only passing receipts in `market_data.cex_order_book_capture_promotions`

`cex_ohlcv` uses `ReplacingMergeTree(broker_version)`; `cex_ohlcv_closed` applies `FINAL` and closed-bar semantics. Order-book physical duplicates remain auditable. The `_canonical` views expose one checksum-consistent logical row, while `_conflicts` expose keys with multiple checksums. Same-batch conflicts are rejected by the forwarder; cross-batch conflicts remain stored and must block the affected replay bundle.

Broker-origin canonical rows remain replay eligible. Physical `external_backfill` rows use provider identity separately from `source`, `historical_vendor_orderbook_v1`, and `vendor_normalized_dataset_file`; they become visible only through `cex_order_book_levels_replay_qualified` and `cex_order_book_depth_summary_replay_qualified` after an exact passing promotion joins their bundle, scope, window, depth, construction mode, and schema. Their old source timestamps are exempt from the broker-origin 90-day live TTL so candidate evidence is not deleted before qualification. Promotion rows have no shorter TTL.

Use `schema/clickhouse/canonical_market_data_replay.sql` for bounded bundle/exchange/pair/source-time replay. Its conflict preflights must return no rows before consuming the canonical views.

The retained FIET-907 reference exporter materializes a conflict-free order-book window directly from ClickHouse to Maker-compatible Parquet files:

```bash
CEX_BROKER_REPLAY_EXPORT_DIRECTORY=/tmp/maker-capture \
CEX_BROKER_REPLAY_CAPTURE_BUNDLE_IDS=cex-2026-08-03-eu-1 \
CEX_BROKER_REPLAY_EXCHANGE=binance \
CEX_BROKER_REPLAY_TRADING_PAIR=BTC-USDT \
CEX_BROKER_REPLAY_START_TIME_MS=1785715200000 \
CEX_BROKER_REPLAY_END_TIME_MS=1785801600000 \
bun scripts/export-canonical-orderbook-parquet.ts

uv run --project research/python --extra dev \
  python research/hummingbot/order_book_parquet_fixture.py \
  /tmp/maker-capture/order_book_levels.parquet \
  /tmp/maker-capture/order_book_depth_summary.parquet
```

The exporter reads replay-qualified views, refuses unqualified external bundles, returns matching promotion receipt IDs, and will not overwrite existing files or export a selected window with an order-book checksum conflict. The Python verifier checks capture-core field presence and recomputes every normalized-row checksum from the Parquet values. Neither tool calls the broker or an exchange. Fixture materialization, coverage reports, and replay-bundle assembly are owned by [FIET-907](https://linear.app/usherlabs/issue/FIET-907/clickhouse-backtest-fixture-materializers-and-coveragereplay-bundles), not by the live capture runtime.

For complete strategy-pair validation, point `CEX_BROKER_REPLAY_VALIDATION_CONFIG` at a JSON document whose `windows` array contains `captureBundleIds`, `exchange`, `tradingPair`, `startTimeMs`, and `endTimeMs`, then run `bun scripts/validate-canonical-market-replay.ts`. Every configured window must contain raw and normalized ORDERBOOK, TICKER, TRADES, and OHLCV evidence; any missing feed or checksum conflict fails validation.

## Migration, cutover, rollback, and deployment observation

The upgraded broker always writes the latest canonical schema. There is no runtime legacy/dual/canonical write setting. Upgrading an existing legacy deployment therefore requires the ClickHouse table migration before the new broker version is deployed.

Follow `schema/clickhouse/migrations/canonical_market_data_replay_cutover.sql` phase by phase: apply canonical DDL, quiesce legacy writers, migrate every retained bounded window, validate parity, switch consumers, and only then deploy the canonical-only broker.

```bash
CEX_BROKER_MIGRATION_START_TIME_MS=1700000000000 \
CEX_BROKER_MIGRATION_END_TIME_MS=1700086400000 \
bun run scripts/migrate-legacy-market-data-to-canonical.ts

# Repeat after reviewing dry-run counts:
CEX_BROKER_CANONICAL_MIGRATION_CONFIRM=true \
CEX_BROKER_MIGRATION_START_TIME_MS=1700000000000 \
CEX_BROKER_MIGRATION_END_TIME_MS=1700086400000 \
bun run scripts/migrate-legacy-market-data-to-canonical.ts
```

The script reads `market_data.orderbook_snapshots` and `market_data.candles` directly from ClickHouse and writes their canonical equivalents. It never reads fixture files and never calls a broker or exchange. Legacy migration stamps `legacy_migration_v1` and `provenance_complete=0`; unavailable bundle/raw ID/raw scope/raw checksum remain `NULL`. Reruns preserve identical logical checksums: order-book canonical views collapse agreeing physical deliveries and OHLCV replacement semantics select the recorded broker version.

Before cutover, run the parity and replay queries for every configured pair/window and complete the FIET-937 production observation window. Record feed health, last-frame age, reconnects, unrecoverable gaps, received/archived/invalid/sampled rows, queue saturation, journaled rows, checksum conflicts, parity mismatches, and Maker replay consumption. Any unaccounted row, conflict, parity mismatch, stale feed, or persistent journal growth blocks deployment cutover. This operational gate is not an implementation-completion requirement for the archived OpenSpec change and repository checks do not claim that it has occurred.

Rollback stops the upgraded broker, restores retained legacy names if necessary, and rolls back to the previous legacy-writing application version. The runbook uses renames rather than drops; canonical and legacy base data remain recoverable throughout the retention period.
