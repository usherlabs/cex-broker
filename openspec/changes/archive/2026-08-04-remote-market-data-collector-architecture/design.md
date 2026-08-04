## Context

The collector supervision class is already a gRPC client that accepts a broker target, but its executable starts an in-process `getServer()` instance on a random loopback port, passes an empty broker pool, and then subscribes to that private server. The result is a second, credentialless public CCXT deployment rather than a keep-alive client of the configured full broker. Capture environment and bundle fields are consequently duplicated into the collector process even though the broker's archive writer constructs and persists the rows.

The full broker already owns environment-first credential selection, capture context construction, archive source, deployment identity, capture bundle, and the archive writer. The repository also lacks one document that distinguishes its public broker, internal forwarder, operator collector, research service, and offline tools.

## Goals / Non-Goals

**Goals:**

- Make the collector a small independent process that only opens, observes, reconnects, and cancels gRPC `Subscribe` streams.
- Keep production-row provenance strict without making optional market archival a dependency of the full broker's gRPC availability.
- Preserve feed isolation, reconnect metrics, explicit gaps, OHLCV bootstrap options, and the legacy OHLCV configuration wrapper.
- Establish a root service-architecture document that describes actual process, credential, persistence, and deployment boundaries.

**Non-Goals:**

- Changing the broker protobuf or reducing its full RPC surface.
- Adding broker or collector TLS/authentication beyond the existing trusted-network/IP-whitelist model.
- Changing archive-forwarder delivery, spool, ClickHouse schemas, or Maker conformance.
- Renaming the existing collector directory or removing the legacy command/configuration wrapper.

## Decisions

### 1. The collector connects to one explicit deployed broker target

`CEX_BROKER_URL` is required by the collector executable and is a gRPC `host:port` target without an HTTP scheme. The loader accepts hostnames, IPv4, and bracketed IPv6 with ports and rejects missing or ambiguous targets. There is no localhost default because a silent default can accidentally reconnect a production collector to the wrong process.

Alternative considered: retain an embedded broker for self-contained deployment. Rejected because it duplicates provider connections and bypasses the deployment's credentials, policy, and archive identity.

### 2. The collector owns only feed intent and supervision

The canonical JSON contains only `subscriptions` and feed-specific options. `environment` and `captureBundleId` are removed and rejected by the strict schema. The existing OHLCV array remains a compatibility input. The collector sends no API-key metadata and relies on the remote broker's established environment-first credential resolution.

Alternative considered: accept provenance fields but ignore them. Rejected because accepted-but-ineffective fields create false assurance that the remote broker uses matching identity.

### 3. Optional market archival does not gate the broker

The full broker starts its normal `ExecuteAction` and `Subscribe` service when archive delivery is absent or disabled. When archival is enabled but production deployment or capture-bundle provenance is incomplete, canonical market-data archival is ineligible: the broker emits one bounded diagnostic per startup/reconfiguration and skips market archive work without affecting stream delivery. Production row construction remains strict, so an incomplete row cannot be emitted accidentally.

The runtime does not enforce `broker_read` as an availability policy because `broker_write` is valid provenance for TEE/write-broker observations and subscription traffic does not identify a FIET-901 deployment. FIET-901 deployment verification must require `broker_read`, an explicit deployment ID, and an explicit capture bundle before declaring continuous capture ready.

Explicit `CEX_BROKER_ARCHIVE_ENABLED=true` remains an operator request for the shared archive writer. Its existing forwarder URL and durable loss-journal validation remains fail-closed so an explicit archive rollout cannot silently discard all archive classes.

No new core broker environment variables are introduced.

### 4. Feed-neutral naming is additive

`MarketDataCollector` and `start-market-data-collector` become canonical names. `OhlcvCollector`, `start-ohlcv-collector`, the existing directory, image, and OHLCV array configuration remain compatibility aliases.

### 5. Service documentation is an architectural contract

`SERVICES_ARCHITECTURE.md` describes the full broker, collector, archive-forwarder, and research candle viewer uniformly; classifies examples and offline utilities separately; and shows minimal, archived, continuous-capture, and research deployment profiles. It describes the forwarder only at its stable service boundary so concurrent forwarder-conformance work does not overlap this change.

## Risks / Trade-offs

- [Existing canonical collector JSON contains removed fields] -> Fail clearly at startup and document moving those values to the broker deployment environment.
- [Collector and broker are now separate failure domains] -> Keep independent bounded reconnect supervisors and expose current state, last frame, and reconnect counters.
- [Running old and new collectors together duplicates captures] -> Require stop-before-start rollout with one collector per subscription set.
- [Remote gRPC remains plaintext] -> Require a trusted deployment network and broker IP whitelist; TLS is a separate change.
- [Incomplete production provenance could produce repeated per-frame errors] -> Resolve market-archive eligibility before normalization, skip ineligible work, and emit only a bounded startup/reconfiguration warning.
- [Concurrent forwarder work touches nearby documentation] -> Avoid changing forwarder behavior or its change artifacts and keep service documentation at the stable interface level.

## Migration Plan

1. Configure the full broker with existing production capture, `broker_read`, deployment, bundle, forwarder, and durable loss-journal values.
2. Permit the collector's network identity through the broker IP whitelist and verify the broker starts successfully.
3. Remove `environment` and `captureBundleId` from collector JSON and set collector-only `CEX_BROKER_URL`.
4. Stop the embedded collector before starting the remote collector to avoid duplicate provider subscriptions.
5. Verify every configured supervisor is healthy and canonical rows carry the broker deployment's source, deployment, and bundle identities.

Rollback stops the remote collector and restores the prior collector image and configuration. No protobuf or database rollback is required.

## Open Questions

None.
