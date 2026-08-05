## 1. Contract And Configuration Tests

- [x] 1.1 Add failing tests for required and malformed collector `CEX_BROKER_URL` targets.
- [x] 1.2 Add failing tests that canonical collector JSON accepts only subscriptions and rejects collector-owned environment or capture-bundle identity.
- [x] 1.3 Add failing broker tests for optional archive startup, non-throwing market-archive eligibility, complete `broker_read`/`broker_write` provenance, and retained explicit sink validation.

## 2. Remote Collector Service

- [x] 2.1 Add the fail-closed collector broker-target loader and reduce canonical collector configuration to feed intent.
- [x] 2.2 Refactor the collector entrypoint to connect to the deployed broker without starting a loopback broker, CCXT exchange, or archive writer.
- [x] 2.3 Make `MarketDataCollector` canonical and add `start-market-data-collector` while retaining OHLCV compatibility aliases.
- [x] 2.4 Replace embedded-exchange process tests with remote fake-broker connection, reconnect, and prompt shutdown coverage.

## 3. Broker Capture Ownership

- [x] 3.1 Replace the throwing production validator with non-throwing market-archive eligibility and preserve strict production row construction.
- [x] 3.2 Keep the full broker available when optional market archival is absent or ineligible, emit a bounded diagnostic, and preserve explicitly enabled writer sink validation.
- [x] 3.3 Add integration coverage proving archive-free production and valid `broker_read`/`broker_write` deployments retain the full RPC service and existing credential resolution.

## 4. Service Architecture Documentation

- [x] 4.1 Add root `SERVICES_ARCHITECTURE.md` with service inventory, process and credential boundaries, data flows, and deployment profiles.
- [x] 4.2 Classify the collector as an operator keep-alive client, distinguish services from tools, and identify externally owned systems without expanding CEX Broker ownership.
- [x] 4.3 Link the architecture document from the main README and update collector/optional-archive operations documentation without overwriting forwarder-conformance work.

## 5. Verification

- [x] 5.1 Run focused collector and production-capture tests, then the full Bun test suite.
- [x] 5.2 Run TypeScript build, lint, server-line guard, and archive-forwarder contract regressions.
- [x] 5.3 Run strict OpenSpec validation and confirm the separate Maker/archive-forwarder conformance change remains untouched.
