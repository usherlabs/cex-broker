## Context

The live/hot cutover is implemented and archived, but PR review found cross-cutting validation gaps that can make behavior depend on malformed configuration, caller-controlled row provenance, oversized measurement metadata, legacy ClickHouse physical types, or incomplete sidecar queries. The fixes must preserve append-only evidence, non-destructive startup, Maker/CEX ownership separation, and the existing public package boundary.

## Goals / Non-Goals

**Goals:**

- Fail closed before routing or persistence when deployment identity or ORDERBOOK evidence is malformed.
- Make measurement-band work predictably bounded.
- Make summary-v2 supported-view types identical across fresh and upgraded databases without mutating legacy physical rows during startup.
- Make Proof C prove exact producer/run persistence rather than existence of a declared subset.
- Keep image-smoke execution bounded.

**Non-Goals:**

- Do not deploy or execute the terminal destructive migration.
- Do not add batch identifiers to the five strategy table schemas.
- Do not change shared fixture values unless the normative summary output changes.
- Do not redefine capture-profile IDs as whitespace-normalized identities.
- Do not claim that a validation marker alone proves venue exhaustion.

## Decisions

1. **Closed measurement-band bounds:** normalize to ascending unique values, then require cardinality `1..64` and each value in `1..10000`. This prevents negative bid boundaries and bounds all aligned arrays. The same constants and semantics are enforced by writer and forwarder validators.

2. **Blank configuration is invalid:** environment values are trimmed and empty values normalized to absence, but explicitly partial or blank market identity configuration fails startup. Both values genuinely absent remains valid for a forwarder that rejects market traffic but serves independent archive classes.

3. **Per-row deployment binding:** every market row must carry the configured deployment ID matching the envelope. This closes provenance overrides for generic non-ORDERBOOK market rows.

4. **Stable supported view over legacy physical tables:** retain nullable legacy physical columns and additive startup. Replace wildcard supported-view projection with an explicit normative field list and `assumeNotNull`/type casts after filtering complete v2 rows. This avoids unsafe physical type mutation while guaranteeing the downstream query contract.

5. **Exact Proof C row-set comparison:** query all `archive_event_id` values for the exact deployment/source/producer/run identity, require exact set equality with Maker evidence, and require `delivery.batchId` to equal the run ID used by the accepted spool batch convention. No strategy-table schema expansion is needed.

6. **Bounded in-container probe:** use `AbortSignal.timeout(2000)` inside each Docker health probe so the outer 30-attempt loop and cleanup remain bounded.

7. **Review items closed by explanation:** capture-profile IDs remain opaque and are validated as non-empty, not trimmed into a different identity. Conservative profiles carry `exhausted=false`; therefore a validated evidence envelope cannot grant exact exhaustion by itself.

## Risks / Trade-offs

- **Explicit view projections are verbose and can drift** → derive tests from the normative field list and compare `DESCRIBE` output on an upgraded database.
- **A 64-band limit is a new rejection boundary** → document it in both raw and summary contracts and test the boundary values.
- **Exact Proof C set checks can expose producer overproduction previously ignored** → this is intended; diagnostics include expected and observed IDs.
- **Blank-pair handling can affect deployments relying on empty environment values** → fail-fast startup is safer than silently enabling ambiguous provenance.
