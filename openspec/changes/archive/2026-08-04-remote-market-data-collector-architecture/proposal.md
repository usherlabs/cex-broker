## Why

The generalized market-data collector currently embeds a private, credentialless loopback broker even though the canonical capture design says it supervises subscriptions on the deployed full broker. This duplicates CEX connections, bypasses the deployment's environment-loaded read credentials, and leaves service boundaries fragmented across several documents.

## What Changes

- Replace the collector entrypoint's embedded gRPC broker with an explicit connection to the deployed full CEX Broker.
- Make the collector a feed-neutral subscription keep-alive service that owns reconnect and health supervision only; the broker owns CEX credentials, capture provenance, and archival.
- **BREAKING**: Require a collector-only `CEX_BROKER_URL` gRPC target and remove `environment` and `captureBundleId` from the canonical collector JSON configuration.
- Keep the full broker available when optional market archival is absent or lacks production provenance; FIET-901 archive-role conformance remains a deployment verification concern.
- Add a canonical `start-market-data-collector` command while retaining the existing OHLCV command and configuration wrapper as compatibility aliases.
- Add a root `SERVICES_ARCHITECTURE.md` that classifies every repository-owned service and distinguishes runtime services from examples, migrations, exporters, and research tools.

## Capabilities

### New Capabilities

- `cex-broker-service-architecture`: Repository-level service inventory, process boundaries, deployment profiles, credentials, and ownership documentation.

### Modified Capabilities

- `cex-market-data-replay-capture`: Require the collector to supervise a separately deployed full broker while keeping optional market archival outside the broker availability path.

## Impact

- Collector entrypoint, configuration, naming aliases, Docker documentation, shutdown behavior, and tests.
- Full broker market-archive eligibility and bounded diagnostics using existing archive environment variables.
- Main README and canonical capture documentation.
- No protobuf, ClickHouse schema, archive-forwarder behavior, Maker repository, or CEX credential-precedence changes.
