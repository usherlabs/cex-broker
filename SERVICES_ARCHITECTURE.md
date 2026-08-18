# CEX Broker service architecture

This document is the architectural authority for long-running processes owned by this repository. It explains which process owns CEX access, subscriptions, archive delivery, and ClickHouse access. Detailed configuration and runbooks remain in the linked component documentation.

## System boundary

```text
third-party clients ── gRPC ───────────────┐
                                           ▼
operator market-data collector ─ gRPC ─► full CEX Broker ── CCXT ──► CEX
                                           │
                                           │ archive HTTP batches
                                           ▼
external archive producers ── HTTP ─► archive-forwarder ── native HTTP ─► ClickHouse
                                                                            ▲
                                                                            │ direct reads
                                              candle viewer / research tools ┘
```

The full broker is the only repository service that owns CEX connections and CEX credential resolution. Within one broker runtime it also owns canonical public-feed workers: compatible collector and third-party `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` subscriptions are independent logical gRPC clients of one physical CCXT watcher and one archive-decision path. Archival therefore still needs an active subscriber, but duplicate prevention does not depend on a singleton collector. The market-data collector is the operator utility that keeps the configured logical subscriptions alive when no third-party client can provide continuous coverage.

The archive-forwarder centralizes trusted ClickHouse writes behind HTTP. It is not a universal ClickHouse proxy: viewers, replay materializers, validators, and externally owned metrics consumers may read ClickHouse directly.

## Repository-owned services

### Full CEX Broker

- Purpose: expose the complete `ExecuteAction` and `Subscribe` gRPC service, apply policy, resolve exchange accounts, and own optional archive capture.
- Entrypoint: `bun run start-broker` (`src/cli.ts`).
- Audience: trusted third-party integrations and the operator market-data collector.
- Interfaces: inbound plaintext gRPC on the configured trusted network; outbound CCXT exchange connections; optional archive-forwarder HTTP, OpenTelemetry, and Verity connections.
- Credentials: environment/deployment broker accounts take precedence over complete request `api-key`/`api-secret` metadata; supported public operations may use a credentialless exchange only when neither source exists. Archive role never determines credential selection or exchange permissions.
- Persistence: none in the minimal profile. With archival enabled, the process owns its bounded delivery queue and configured durable archive loss journal; ClickHouse persistence remains behind the forwarder.
- Deployment and failure: required for every profile except research-only reads. A broker outage interrupts both direct clients and collector subscriptions. Missing or disabled archival never blocks the gRPC service. When an enabled writer lacks complete production market provenance, canonical market archival is skipped with a bounded warning while RPCs remain available; FIET-901 deployment verification separately requires `broker_read`, an explicit deployment ID, and a capture bundle ID.
- Operations: [README.md](README.md) and [docs/canonical-market-data-replay.md](docs/canonical-market-data-replay.md).

Public ORDERBOOK workers retain normalized price-aggregated L2 `[price, amount]` levels before subscriber projection. FIET Maker uses those levels as immediate-hedgeability evidence: displayed bids inside a position band bound sell capacity and displayed asks bound buy capacity. This does not claim L3 order identity, queue priority, executed volume, or guaranteed fills. A subscriber `depthLimit` is a top-N presentation count, whereas policy sufficiency is a price-band property: retained bid and ask boundaries must cross every configured band (or explicitly prove visible-book exhaustion). Deployments using the archive for Maker replay align archive depth with the policy depth and verify band coverage; the ordinary 25-level default is not automatically sufficient for a deeper policy.

ORDERBOOK physical identity is venue-resolved. Verified Binance and MEXC diff-depth profiles retain one bounded 500-level L2 base book for compatible explicit and omitted subscriber projections and the configured archive cap. Unknown venues conservatively preserve explicit-limit versus provider-default workers until equivalent acquisition behavior has been proven. A later request that exceeds a running profile's guarantee starts a separate compatible worker instead of hot-swapping the active feed.

### Market-data collector

- Purpose: keep configured `ORDERBOOK`, `TICKER`, `TRADES`, and `OHLCV` subscriptions alive against one deployed full broker.
- Entrypoint: `bun run start-market-data-collector`; `start-ohlcv-collector` and `services/ohlcv-collector/` remain compatibility names.
- Audience: operator-internal automation. Third-party integrations use the full broker directly.
- Interfaces: outbound plaintext gRPC `Subscribe` calls to the required `CEX_BROKER_URL=host:port` target; optional outbound OpenTelemetry metrics.
- Credentials: none. The collector does not load CEX keys, send API credential metadata, write archives, or connect to ClickHouse. The full broker resolves its deployment credentials.
- Persistence: none. Canonical JSON contains only subscriptions and feed options; archive environment and capture identity belong to the broker deployment.
- Deployment and failure: optional for request-driven broker use, required (or replaceable by an equivalent persistent subscriber) for continuous FIET-901 capture. Every feed has an isolated reconnect supervisor with bounded backoff; stopping the collector cancels its streams but does not stop the remote broker.
- Operations: [docs/canonical-market-data-replay.md](docs/canonical-market-data-replay.md).

### Archive-forwarder

- Purpose: accept supported archive envelopes over trusted HTTP, validate their contract, initialize supported schemas, and write accepted rows to ClickHouse.
- Entrypoint: `bun run start-archive-forwarder` (`services/archive-forwarder/index.ts`).
- Audience: internal broker deployments and separately owned producers whose envelope contract is supported.
- Interfaces: inbound HTTP archive and health routes; outbound ClickHouse native HTTP and OpenTelemetry connections.
- Credentials: ClickHouse and optional forwarder-auth credentials only; it owns no CEX credentials.
- Persistence: ClickHouse is the archive system of record. Producer-specific delivery, retry, and durability responsibilities are defined by their contracts and are not reassigned by this architecture document.
- Deployment and failure: optional for a minimal broker and required when broker archival is enabled. If it or ClickHouse is unavailable, the broker's archive queue/loss-journal behavior applies independently of live gRPC frame delivery.
- Operations: [docs/research-backtest.md](docs/research-backtest.md) and [docs/canonical-market-data-replay.md](docs/canonical-market-data-replay.md).

### Research candle viewer

- Purpose: provide a browser view and JSON API over archived candles for local research.
- Entrypoint: `bun run start-candle-viewer` (`research/candle-viewer/server.ts`).
- Audience: research-only users; it is not a production broker or ingest service.
- Interfaces: inbound HTTP UI/API; direct read-only ClickHouse queries.
- Credentials: ClickHouse read configuration only.
- Persistence: none.
- Deployment and failure: optional. Its failure does not affect broker, collector, archive delivery, or ClickHouse ingestion.
- Operations: [research/candle-viewer/README.md](research/candle-viewer/README.md).

## Services, tools, and external systems

The following repository components are not production services:

- `examples/archive-watch-subscribe.ts` is an interactive/local subscription example, not the managed continuous collector.
- `scripts/migrate-legacy-market-data-to-canonical.ts`, replay validators, and Parquet exporters are bounded operator tools that access ClickHouse directly.
- `scripts/archive-upgrade-acceptance.ts` is the one-time Server 24.8 A/B acceptance harness for the canonical upgrade. It creates isolated A and B databases from the committed `develop` fixture, leaves A immutable, upgrades B with the production schema/migration path, and is not a recurring CI service.
- `scripts/archive-sidecar.ts` and its supervisor form a bounded cross-repository test composition. They assemble Server 24.8, the production archive-forwarder, a normal deterministic gRPC broker, and an independent collector for FIET Maker conformance; they do not add a production broker startup mode.
- `research/python/` and `research/hummingbot/` are research libraries and reference integrations, not broker-side daemons.
- `schema/`, handlers, helpers, generated protobuf modules, and test fixtures are libraries or assets embedded in the services above.

CEX venues, ClickHouse, OpenTelemetry infrastructure, and Verity are external dependencies. FIET Maker/Hummingbot runtimes, `fiet-observer`, and other archive or metrics producers are owned by their respective repositories. Their direct ClickHouse reads or supported archive-forwarder writes do not make them CEX Broker services.

## Deployment profiles

| Profile | Required processes | Optional processes | Result |
| --- | --- | --- | --- |
| Minimal broker | Full broker | OpenTelemetry, Verity | Full third-party gRPC surface; no continuous archive guarantee. |
| Archived broker | Full broker, archive-forwarder, ClickHouse | OpenTelemetry, Verity | Requests and active subscriptions can be archived; coverage lasts only while subscribers are connected. |
| Continuous FIET-901 capture | Deployment-verified `broker_read` full broker, market-data collector, archive-forwarder, ClickHouse | Research readers | The collector keeps feed subscriptions alive while the broker owns CEX access, provenance, and archive delivery. |
| Research-only | ClickHouse plus the selected viewer or offline tool | Candle viewer, Python/Hummingbot readers | Reads existing data without running or impersonating the broker ingest path. |

## Test and cross-service compositions

The standard archive E2E gate uses pinned ClickHouse Local for deterministic lifecycle and failure testing. The canonical-upgrade A/B command instead uses two real Server 24.8 instances and is recorded once for this upgrade: its A-side is the immutable fixture exported from CEX Broker `develop` at `7a83de5f29a08f42d81f64a75a83bc9318dce94a`; its B-side is the current candidate. Local success is not evidence for the Server transport or migration, and the fixed A/B command is intentionally absent from ordinary CI.

FIET Maker drives the sidecar from its own pinned `develop` checkout. In both profiles, the collector is a separate operator client that keeps broker subscriptions active; it is never presented as Maker. When collector and Maker options resolve to the same Binance/MEXC acquisition profile, two logical deliveries share one broker-owned physical watcher and archive decision. `native_replay` writes externally produced strategy reports synchronously as `maker_replay` and exercises the FIET-907 direct-ClickHouse Parquet boundary. `production_compatible` admits externally produced `hb_runtime` reports with HTTP 202 to the durable strategy spool and verifies drainage into ClickHouse. The sidecar never stands in for Maker: it publishes an ephemeral producer-access file and broker endpoint, distinguishes collector subscriptions from the external Maker subscription, and accepts only the exact Maker producer identity in its result and ClickHouse queries. See [docs/archive-upgrade-and-sidecar.md](docs/archive-upgrade-and-sidecar.md).

For a continuous-capture rollout, configure and start the full broker first, align ORDERBOOK archive depth with the Maker policy, verify archive health and L2 band coverage, then start the collector. Overlapping collector replacement creates additional logical subscriptions but compatible subscriptions remain on one physical broker feed; stop the old collector after the replacement is healthy to keep operational liveness and client-count evidence clear.
