## Why

PR #158 review identified fail-open and parity gaps at the live/hot archive boundary: blank deployment configuration, row-level provenance overrides, unbounded or invalid measurement bands, an unbounded image-health probe, incomplete Proof C exactness, and an upgraded ClickHouse view whose types can differ from a fresh install. These gaps should be closed before merge so the implemented boundary is both fail-closed and installation-independent.

## What Changes

- Reject blank or partially configured archive-forwarder market identities.
- Require every market row to match the configured deployment identity as well as the envelope source.
- Bound normalized ORDERBOOK measurement bands to at most 64 unique entries in `1..10000` basis points and enforce the same contract at writer, raw, and summary admission.
- Restore a bounded timeout to the in-container archive-forwarder image health probe.
- Make Proof C compare the complete strategy row-ID set for the expected producer/run rather than only a caller-declared subset, while binding the declared batch identity to the run contract.
- Expose an explicit, stable summary-v2 supported-view projection whose names, order, nullability, and types are the same on fresh and upgraded ClickHouse installations.
- Document why opaque capture-profile IDs are not trimmed and why conservative non-exhausted observations do not acquire exactness from the validation marker alone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cex-market-data-replay-capture`: Close deployment identity and measurement-band admission.
- `cex-order-book-replay-archive`: Bound measurement bands and stabilize the upgraded summary-v2 supported view.
- `maker-archive-sidecar-conformance`: Require complete producer/run row-set equality and bounded verification behavior.
- `archive-e2e-regression`: Add upgrade-path type parity and rejected-configuration/provenance cases.
- `cex-broker-service-architecture`: Keep service-owned smoke verification bounded and fail-closed.

## Impact

Affected areas include archive-forwarder configuration/admission, canonical ORDERBOOK normalization, raw and summary validators, ClickHouse canonical views, sidecar verification, image smoke, unit/integration/E2E tests, and the corresponding main OpenSpec contracts. No new package surface or production deployment action is introduced.
