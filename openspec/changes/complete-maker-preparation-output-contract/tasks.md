## 1. Confirm the Baseline and Create RED Evidence

- [ ] 1.1 Verify the implementation and main-spec baseline is v0.2.50 plus PR #155 commit `7db59163428087edc67752d00619ea883d6354dd`, and confirm this change modifies rather than duplicates its six executable requirements.
- [ ] 1.2 Capture the exact user-reported failing unit command, Bun/Node versions, environment assumptions, failing assertions, and branch commit as a reproducible RED evidence artifact.
- [ ] 1.3 Add failing command-level tests proving provider sequence, object, and clock failures commit result v2 with detailed subcodes, exact bounded diagnostic keys, producer identity, and redaction.
- [ ] 1.4 Add failing contract tests proving previous and mixed capability/resource tuples are rejected before archive, capability, credential, provider, and forwarder access.
- [ ] 1.5 Add failing selection tests proving a vendor bundle with only a historical-policy receipt cannot support a current `already_covered` or export success.
- [ ] 1.6 Add failing OKX reconstruction tests for full-clock scanning, unanchored intervals, later complete-snapshot re-anchoring, affected-target failure, and non-affecting gap evidence.
- [ ] 1.7 Add regression tests preserving caller-owned attempt confinement, no-follow reads, traversal/symlink/byte-cap rejection, atomic replacement, exporter read-only authority, and `cex-broker` bin compatibility.

## 2. Normalize the Current Policy, Receipt, and Result Path

- [ ] 2.1 Remove legacy and previous policy lookup arrays from request decoding and domain execution so only the exact capability-v3/resource-v2 tuple can resolve a live request.
- [ ] 2.2 Make every previous or mixed tuple commit atomic `request_invalid` result-v2 evidence before dependency construction or network access.
- [ ] 2.3 Make qualified archive resolution exclude selected vendor bundles whose latest passing receipt does not bind the exact current capability, resource, adapter, and acquisition pins.
- [ ] 2.4 Add full current-policy reverification that appends a new current receipt without rewriting or relabeling historical receipt bytes.
- [ ] 2.5 Make result, receipt, conformance fixture, schema manifest, and product pin construction assert one coherent current identity chain.
- [ ] 2.6 Remove result-v1 executable emission, current-package runtime fallback codecs/exports, and legacy-policy conformance behavior while retaining historical evidence with its immutable release.
- [ ] 2.7 Enforce the exact executable environment allowlist `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CEX_BROKER_ARCHIVE_FORWARDER_URL`, `CEX_BROKER_ARCHIVE_FORWARDER_TOKEN`, and `CRYPTOHFTDATA_API_KEY`.
- [ ] 2.8 Regenerate current backfill conformance fixtures, declarations, and documentation for one request-v1/result-v2 and capability-v3/resource-v2 path.

## 3. Align OKX Reconstruction and Maker-Facing Diagnostics

- [ ] 3.1 Change OKX gap handling to record the discontinuity, clear current book state, and remain unanchored until a later complete snapshot.
- [ ] 3.2 Scan the full pair-local required clock before mapping affected OKX targets to `vendor_fetch_failed/update_chain_gap`.
- [ ] 3.3 Preserve immediate failure for ambiguous groups, invalid values, crossed or one-sided books, and unsupported non-OKX continuity semantics.
- [ ] 3.4 Freeze the nine closed statuses and exact result-v2 coverage, sequence, first/last time, maximum-lag, and six cumulative lag-bucket diagnostic keys.
- [ ] 3.5 Restrict provider-object diagnostics to safe identity, checksum, failure phase, attempt count, and quarantine fields and redact reflected secret values before hashing.
- [ ] 3.6 Add deterministic tests proving re-anchored samples, failures, detailed subcodes, and diagnostics reproduce across chunk and provider-object boundaries.

## 4. Implement Bounded Source-Forensics Evidence

- [ ] 4.1 Define and test published `market-data-source-forensics-ledger/v1` and `market-data-source-qualification-record/v1` schemas, canonical hashes, strict validation, safe relative paths, and deterministic ordering.
- [ ] 4.2 Add a typed reconstruction observation interface covering provider-object boundaries, snapshot anchors, sequence transitions/gaps, required-clock samples, invalidations, and re-anchors.
- [ ] 4.3 Keep forensics library-only and add package tests proving there is no third executable and no Maker request observer field.
- [ ] 4.4 Implement a no-op production sink and prove observer-disabled and observer-enabled reconstruction return identical samples, failures, subcodes, and summary diagnostics.
- [ ] 4.5 Implement a streaming sink capped at exactly 100,000 retained records and 67,108,864 canonical UTF-8 JSON bytes; overflow must continue reconstruction, count omissions, and finish `complete = false` without throwing.
- [ ] 4.6 Emit closed record kinds for sequence discontinuity, unanchored interval, stale interval, future-state interval, and provider-object checksum conflict.
- [ ] 4.7 Bind pair, request, clock, current policies, provider-object identities/checksums, sequences, surrounding anchors, affected target intervals/counts, and lag buckets in every applicable record.
- [ ] 4.8 Implement bounded re-fetch and the closed classifications `stable_object_corruption`, `mutable_provider_bytes`, `provider_row_loss`, `object_boundary_order_defect`, `valid_inactive_market_state`, and `unresolved`.
- [ ] 4.9 Ensure diagnostic alternate-order replay can only form a classification hypothesis and cannot repair or certify an interval; require a production fix and complete-window rerun.
- [ ] 4.10 File-sync the ledger before atomically committing its qualification record and verify descriptor hash, bytes, retained/total/omitted records, completeness, and licensed-payload cleanup.
- [ ] 4.11 Add adversarial secret-reflection, changing-bytes, stable-corruption, cross-object sequence, missing-anchor, stale-clock, future-state, checksum-conflict, valid-inactivity, overflow, and deterministic-replay tests.

## 5. Version and Validate Exact Export Outputs

- [ ] 5.1 Define immutable levels-Parquet and depth-summary-Parquet projection documents with ordered capture-core columns, physical/logical types, nullability, metadata, `cex-order-book-canonical/v1` consistency, and RFC 8785 identities.
- [ ] 5.2 Add `cex-canonical-orderbook-export-result/v2` so each descriptor requires safe file name, rows, bytes, SHA-256, projection schema ID, and projection schema SHA-256.
- [ ] 5.3 Version the exporter product as `cex-canonical-orderbook-export/v2` while retaining export request v1 and backfill product `market-data-vendor-backfill/v1`.
- [ ] 5.4 Validate each produced Parquet file's ordered columns, physical/logical types, nullability, and metadata against its canonical projection document before committing success.
- [ ] 5.5 Map projection mismatch to `archive_data_invalid/parquet_projection_schema_mismatch` with null successful descriptors and no Maker-eligible partial file.
- [ ] 5.6 Preserve exact selection compilation, archive-wins overlap, current receipt validation, query identity, ordered segments, and exclusion of unselected rows.
- [ ] 5.7 Extend exact-export, ClickHouse, and file-job tests to reproduce query, receipt, artifact, row-count, projection, and atomic write identities.

## 6. Regenerate the Package Identity Chain

- [ ] 6.1 Generate schema manifest v3 with exactly twelve current entries: six unchanged preparation schemas, export result v2, product pin v2, two projection schemas, forensic ledger v1, and qualification record v1.
- [ ] 6.2 Define `cex-market-data-preparation-product-pin/v2` to bind manifest v3, all twelve schemas, capability v3, resource v2, and exactly two executable identities.
- [ ] 6.3 Update build and package-copy logic so both executables, runtime dependencies, policies, fixtures, declarations, all twelve schemas, and the manifest are present without server imports.
- [ ] 6.4 Map registry `gitHead`, product pin `package.npm_git_head`, and result `producer.package.git_head` to the same baked release commit without renaming stable wire fields.
- [ ] 6.5 Add clean-extraction Node 22 package tests that verify every pin, both product versions, `fiet_tee_commit` absence, standalone execution, and existing `cex-broker` bin behavior.
- [ ] 6.6 Publish updated cross-language fixtures for Maker and prove TypeScript and Python reproduce every document, descriptor, policy, and product-pin identity.

## 7. Complete Deterministic Verification

- [ ] 7.1 Make the exact external unit command from task 1.2 pass with zero failures and retain matching GREEN evidence beside the RED artifact.
- [ ] 7.2 Run the repository-declared unit suite with zero failures and retain its command, tool versions, test count, assertion count, and commit.
- [ ] 7.3 Run build, TypeScript checks, changed-file Biome checks, strict OpenSpec validation, file-job conformance, package audit, and generated-identity verification.
- [ ] 7.4 Run caller-owned attempt-directory, no-follow, symlink/traversal/byte-cap, atomic-result, and stale-success file-job tests for both executables.
- [ ] 7.5 Run ClickHouse integration and exact-selection exporter tests against replay-qualified views, conflicts, historical/current receipt changes, archive-wins overlap, and physical projection validation.
- [ ] 7.6 Run archive-forwarder image smoke and production-authorization tests while proving the exporter retains qualified-archive-read-only access.
- [ ] 7.7 Run request, result, log, receipt, forensic-ledger, qualification-record, and package secret-reflection audits and prove no licensed provider rows or response bodies are retained.

## 8. Qualify, Publish, and Close the Cross-Repository Boundary

- [ ] 8.1 Freeze one common 20-to-30-complete-UTC-day candidate and independent ARB-USDT and ARB-USDC clock IDs, hashes, and exact event counts without changing the 5,000 ms bound or resource-policy ceiling.
- [ ] 8.2 Run full-window capability-v3 qualification for each pair and retain one complete content-addressed forensic ledger and qualification record per pair.
- [ ] 8.3 Classify every sequence, unanchored, stale, future-state, object, checksum, and boundary failure; fix only evidenced CEX defects or prepare a secret-free vendor escalation for stable upstream defects.
- [ ] 8.4 Repeat complete-window qualification after every correction until both ledgers are complete with zero affected required targets, zero future state, and no unresolved classifications.
- [ ] 8.5 Run ClickHouse-first `fill_gaps` at depth 100 for each pair and retain a current `promoted` or `already_covered` result, complete exact selection, required current receipts, archive-wins lineage, and coherent current identities.
- [ ] 8.6 Run exporter v2 for each complete selection and verify exact query identity, selected segments, receipt IDs, schema-identified descriptors, and Parquet contents.
- [ ] 8.7 Choose a fresh successor package version only after deterministic checks and both source-qualification gates pass.
- [ ] 8.8 Publish the successor, independently download the registry tarball, and audit npm integrity, tarball SHA-256, npm `gitHead`, package contents, policies, manifest v3, all twelve schemas, and both executable hashes.
- [ ] 8.9 Generate and check in final product pin v2 from audited registry bytes; do not use local candidate identities as release evidence.
- [ ] 8.10 Have Maker update schema copies and product pin, validate both pair outputs, run its real loader, and bind consumer proof to CEX results, selections, receipts, query identities, and descriptors.
- [ ] 8.11 Record final CEX acceptance evidence showing both pair-scoped output chains pass while Maker retains ownership of atomic two-pair publication, final artifacts, policy proof, and thesis execution.
- [ ] 8.12 Review the final diff for no live legacy policy/result path, no Fiet TEE dependency, no Maker domain logic in CEX, no server import from preparation products, and no weakening of file-job or source qualification safety.
