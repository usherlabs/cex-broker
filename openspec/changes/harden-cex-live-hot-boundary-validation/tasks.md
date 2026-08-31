## 1. Admission and measurement bounds

- [x] 1.1 Reject blank or partial forwarder market identity configuration with focused tests.
- [x] 1.2 Require every market row deployment ID to match the configured envelope identity with generic-feed rejection tests.
- [x] 1.3 Add shared `1..64` and `1..10000` measurement-band bounds to writer normalization, raw admission, summary admission, and tests.

## 2. View and conformance hardening

- [x] 2.1 Replace wildcard summary-v2 canonical projection with an explicit normative typed projection that is stable on legacy upgrades.
- [x] 2.2 Add upgraded-schema projection parity and retain the typed real-ClickHouse fixture gate.
- [x] 2.3 Make Proof C compare the complete producer/run archive-event ID set and bind the declared batch ID to the run identity.
- [x] 2.4 Restore a two-second timeout to each in-container image health probe.

## 3. Qualification and review closure

- [x] 3.1 Run focused tests, TypeScript/Biome/LSP checks, strict OpenSpec validation, full unit tests, image smoke, real ClickHouse typed projection, and archive E2E.
- [x] 3.2 Record explanatory dispositions for opaque capture-profile IDs and conservative non-exhaustion evidence.
- [ ] 3.3 Commit and push all accepted review fixes to Gitea and GitHub PR #158, wait for checks, reply to every review thread, and mark each resolved.
