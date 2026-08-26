## 1. Confirm the Baseline and Create RED Evidence

- [x] 1.1 Verify the implementation and main-spec baseline is v0.2.50 plus PR #155 commit `7db59163428087edc67752d00619ea883d6354dd`, and confirm this change modifies rather than duplicates its six executable requirements.
- [x] 1.2 Capture the exact user-reported failing unit command, Bun/Node versions, environment assumptions, failing assertions, and branch commit as a reproducible RED evidence artifact.
- [x] 1.3 Add failing command-level tests proving provider sequence, object, and clock failures commit result v2 with detailed subcodes, exact bounded diagnostic keys, producer identity, and redaction.
- [x] 1.4 Add failing contract tests proving previous and mixed capability/resource tuples are rejected before archive, capability, credential, provider, and forwarder access.
- [x] 1.5 Add failing selection tests proving a vendor bundle with only a historical-policy receipt cannot support a current `already_covered` or export success.
- [x] 1.6 Add failing OKX reconstruction tests for full-clock scanning, unanchored intervals, later complete-snapshot re-anchoring, affected-target failure, and non-affecting gap evidence.
- [x] 1.7 Add regression tests preserving caller-owned attempt confinement, no-follow reads, traversal/symlink/byte-cap rejection, atomic replacement, exporter read-only authority, and `cex-broker` bin compatibility.

## 2. Normalize the Current Policy, Receipt, and Result Path

- [x] 2.1 Remove legacy and previous policy lookup arrays from request decoding and domain execution so only the exact capability-v3/resource-v2 tuple can resolve a live request.
- [x] 2.2 Make every previous or mixed tuple commit atomic `request_invalid` result-v2 evidence before dependency construction or network access.
- [x] 2.3 Make qualified archive resolution exclude selected vendor bundles whose latest passing receipt does not bind the exact current capability, resource, adapter, and acquisition pins.
- [x] 2.4 Add full current-policy reverification that appends a new current receipt without rewriting or relabeling historical receipt bytes.
- [x] 2.5 Make result, receipt, conformance fixture, schema manifest, and product pin construction assert one coherent current identity chain.
- [x] 2.6 Remove result-v1 executable emission, current-package runtime fallback codecs/exports, and legacy-policy conformance behavior while retaining historical evidence with its immutable release.
- [x] 2.7 Enforce the exact executable environment allowlist `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CEX_BROKER_ARCHIVE_FORWARDER_URL`, `CEX_BROKER_ARCHIVE_FORWARDER_TOKEN`, and `CRYPTOHFTDATA_API_KEY`.
- [x] 2.8 Regenerate current backfill conformance fixtures, declarations, and documentation for one request-v1/result-v2 and capability-v3/resource-v2 path.

## 3. Align OKX Reconstruction and Maker-Facing Diagnostics

- [x] 3.1 Change OKX gap handling to record the discontinuity, clear current book state, and remain unanchored until a later complete snapshot.
- [x] 3.2 Scan the full pair-local required clock before mapping affected OKX targets to `vendor_fetch_failed/update_chain_gap`.
- [x] 3.3 Preserve immediate failure for ambiguous groups, invalid values, crossed or one-sided books, and unsupported non-OKX continuity semantics.
- [x] 3.4 Freeze the nine closed statuses and exact result-v2 coverage, sequence, first/last time, maximum-lag, and six cumulative lag-bucket diagnostic keys.
- [x] 3.5 Restrict provider-object diagnostics to safe identity, checksum, failure phase, attempt count, and quarantine fields and redact reflected secret values before hashing.
- [x] 3.6 Add deterministic tests proving re-anchored samples, failures, detailed subcodes, and diagnostics reproduce across chunk and provider-object boundaries.

## 4. Implement Bounded Source-Forensics Evidence

- [x] 4.1 Define and test published `market-data-source-forensics-ledger/v1` and `market-data-source-qualification-record/v1` schemas, canonical hashes, strict validation, safe relative paths, and deterministic ordering.
- [x] 4.2 Add a typed reconstruction observation interface covering provider-object boundaries, snapshot anchors, sequence transitions/gaps, required-clock samples, invalidations, and re-anchors.
- [x] 4.3 Keep forensics library-only and add package tests proving there is no third executable and no Maker request observer field.
- [x] 4.4 Implement a no-op production sink and prove observer-disabled and observer-enabled reconstruction return identical samples, failures, subcodes, and summary diagnostics.
- [x] 4.5 Implement a streaming sink capped at exactly 100,000 retained records and 67,108,864 canonical UTF-8 JSON bytes; overflow must continue reconstruction, count omissions, and finish `complete = false` without throwing.
- [x] 4.6 Emit closed record kinds for sequence discontinuity, unanchored interval, stale interval, future-state interval, and provider-object checksum conflict.
- [x] 4.7 Bind pair, request, clock, current policies, provider-object identities/checksums, sequences, surrounding anchors, affected target intervals/counts, and lag buckets in every applicable record.
- [x] 4.8 Implement bounded re-fetch and the closed classifications `stable_object_corruption`, `mutable_provider_bytes`, `provider_row_loss`, `object_boundary_order_defect`, `valid_inactive_market_state`, and `unresolved`.
- [x] 4.9 Ensure diagnostic alternate-order replay can only form a classification hypothesis and cannot repair or certify an interval; require a production fix and complete-window rerun.
- [x] 4.10 File-sync the ledger before atomically committing its qualification record and verify descriptor hash, bytes, retained/total/omitted records, completeness, and licensed-payload cleanup.
- [x] 4.11 Add adversarial secret-reflection, changing-bytes, stable-corruption, cross-object sequence, missing-anchor, stale-clock, future-state, checksum-conflict, valid-inactivity, overflow, and deterministic-replay tests.

## 5. Version and Validate Exact Export Outputs

- [x] 5.1 Define immutable levels-Parquet and depth-summary-Parquet projection documents with ordered capture-core columns, physical/logical types, nullability, metadata, `cex-order-book-canonical/v1` consistency, and RFC 8785 identities.
- [x] 5.2 Add `cex-canonical-orderbook-export-result/v2` so each descriptor requires safe file name, rows, bytes, SHA-256, projection schema ID, and projection schema SHA-256.
- [x] 5.3 Version the exporter product as `cex-canonical-orderbook-export/v2` while retaining export request v1 and backfill product `market-data-vendor-backfill/v1`.
- [x] 5.4 Validate each produced Parquet file's ordered columns, physical/logical types, nullability, and metadata against its canonical projection document before committing success.
- [x] 5.5 Map projection mismatch to `archive_data_invalid/parquet_projection_schema_mismatch` with null successful descriptors and no Maker-eligible partial file.
- [x] 5.6 Preserve exact selection compilation, archive-wins overlap, current receipt validation, query identity, ordered segments, and exclusion of unselected rows.
- [x] 5.7 Extend exact-export, ClickHouse, and file-job tests to reproduce query, receipt, artifact, row-count, projection, and atomic write identities.

## 6. Regenerate the Package Identity Chain

- [x] 6.1 Generate schema manifest v3 with exactly twelve current entries: six unchanged preparation schemas, export result v2, product pin v2, two projection schemas, forensic ledger v1, and qualification record v1.
- [x] 6.2 Define the initial `cex-market-data-preparation-product-pin/v2` to bind manifest v3, all twelve schemas, capability v3, the then-current Candidate-named tape capability, resource v2, and exactly two executable identities; its role-neutral capability/library replacement is reopened in task 9.6.
- [x] 6.3 Update build and package-copy logic so both executables, runtime dependencies, policies, fixtures, declarations, all twelve schemas, and the manifest are present without server imports.
- [x] 6.4 Map registry `gitHead`, product pin `package.npm_git_head`, and result `producer.package.git_head` to the same baked release commit without renaming stable wire fields.
- [x] 6.5 Add the initial clean-extraction Node 22 package tests for both bins, current checkpoint pins, `fiet_tee_commit` absence, standalone execution, and existing `cex-broker` behavior; the source-tape library import/pin extension is pending in tasks 9.5, 9.6, and 9.10.
- [x] 6.6 Publish the initial updated cross-language fixtures for Maker and prove TypeScript and Python reproduce the checkpoint documents, descriptors, policies, and product-pin identity; regenerated role-neutral fixtures remain pending in task 9.6.

## 7. Complete Deterministic Verification

- [x] 7.1 Make the exact external unit command from task 1.2 pass with zero failures and retain matching GREEN evidence beside the RED artifact.
- [x] 7.2 Run the repository-declared unit suite with zero failures and retain its command, tool versions, test count, assertion count, and commit.
- [x] 7.3 Run build, TypeScript checks, changed-file Biome checks, strict OpenSpec validation, file-job conformance, package audit, and generated-identity verification.
- [x] 7.4 Run caller-owned attempt-directory, no-follow, symlink/traversal/byte-cap, atomic-result, and stale-success file-job tests for both executables.
- [x] 7.5 Run ClickHouse integration and exact-selection exporter tests against replay-qualified views, conflicts, historical/current receipt changes, archive-wins overlap, and physical projection validation.
- [x] 7.6 Run archive-forwarder image smoke and production-authorization tests while proving the exporter retains qualified-archive-read-only access.
- [x] 7.7 Run request, result, log, receipt, forensic-ledger, qualification-record, and package secret-reflection audits and prove no licensed provider rows or response bodies are retained.

## 8. Qualify, Publish, and Close the Cross-Repository Boundary

- [ ] 8.1 Complete every reopened pre-freeze task in sections 9 and 10, and have Maker prove deterministic invocation of the role-neutral source-tape package-library operation plus ownership of the cross-stage and cross-pair state machine without live credentials. Do not reserve a version while this gate is open.
- [ ] 8.2 Query npm and reserve an unused successor version, commit it with every implementation and generated identity, merge PR #155, and freeze the exact clean commit that will be tagged and published. Any merge/rebase/squash or byte/`gitHead` change after this point invalidates identity-bound evidence.
- [ ] 8.3 From a clean checkout of the frozen commit, have Maker invoke pair-local CEX source-tape preparation for OKX Spot ARB-USDC and ARB-USDT over the fixed 24-day window; retain separate CEX qualification records, inventories, receipts, selections, export results, and durable pair outcomes without Candidate-role or aggregate-pair interpretation in CEX.
- [ ] 8.4 Classify and remediate every source-enumeration blocker until each pair has complete expected/observed inventory, `source_event_enumeration_eligible = true`, `source_tape_eligible = true`, no contradictory evidence, and semantically verified exported tape bytes under the unchanged source boundary.
- [ ] 8.5 Have Maker materialize its final nominal policy clocks without truncation from DEX inputs, the eligible pair-local OKX tapes, the sole scheduler, and the strict-greater-than freshness-expiry rule; record exact CEX-target and Maker-invocation counts and fail closed before a CEX request if either clock exceeds 100,000 targets.
- [ ] 8.6 Submit each Maker-produced clock through the generic CEX required-clock interface and produce an exhaustive exact three-way source disposition without teaching CEX its Candidate role, scheduler, DEX inputs, or target-to-invocation semantics.
- [ ] 8.7 Classify and remediate every disqualifying required-clock target until each pair's ledger is complete, disposition-complete, `source_partition_complete = true`, and free of contradictory evidence; do not change the fixed window or 5,000 ms bound.
- [ ] 8.8 Have Maker derive the final admitted clocks, complete original-to-admitted mappings, per-invocation `reference_depth_stale` blocked outcomes, and its versioned derivation descriptors; validate those semantics in Maker, not CEX.
- [ ] 8.9 Strictly qualify each admitted clock with `source_reconstruction_accepted`, all-fresh dispositions, and the unchanged 5,000 ms bound before pair-scoped ClickHouse-first `fill_gaps`, depth-100 promotion, exact selection, and exporter-v2 output.
- [ ] 8.10 Retain one durable CEX success or failure result per pair and deliver the pair-local CEX evidence to Maker; CEX MUST NOT publish an atomic ARB-USDC/ARB-USDT verdict.
- [ ] 8.11 Have Maker bind both local candidate outputs into its atomic two-pair verdict, validate both pair products, run the real loader and full-timeline replay, and prove admitted plus blocked runtime denominators before publication.
- [ ] 8.12 Tag and publish the exact frozen commit, independently download and audit the registry tarball, and derive the product pin from its registry URL, integrity, tarball SHA-256, npm `gitHead`, regenerated policies, manifest v3, all twelve schemas, both executable hashes, and the source-tape library runtime/declaration hashes.
- [ ] 8.13 Have Maker replace the local candidate with the independently downloaded registry product and final product pin, then repeat the consumer and full-timeline proof without changing its policy inputs.
- [ ] 8.14 Land the immutable qualification/release evidence through a follow-up evidence PR; do not deploy the qualification archive or forwarder to production.
- [ ] 8.15 Review the final diff and evidence for no live legacy policy/result path, no Fiet TEE dependency, no Maker Candidate/scheduler/DEX/mapping/blocked-outcome or aggregate-pair logic in CEX, no server import from preparation products, no pre-freeze identity evidence, and no weakening of file-job, authorization, source qualification, or archive authority.

## 9. Refine Role-Neutral Source Forensics and the Package-Library Boundary

- [ ] 9.1 Make forensic-ledger validation contextual on the authoritative required-clock document: prove exact target membership, ordering, identity/time equality, count reconciliation, and retained-record interval causality; reject unknown, duplicate, omitted, altered, or unsupported disposition references.
- [ ] 9.2 Make failure classification record/target-scoped, reject contradictory overlapping evidence, and deduplicate bounded original-plus-adjacent re-fetches by provider-object identity before final hashes.
- [ ] 9.3 Convert forensic-ledger v1 and qualification-record v1 into closed `required_clock_qualification`/`source_tape` operation unions; replace CEX `derivation_eligible` and Candidate-named predicates with role-neutral, operation-applicable `source_partition_complete`, `source_event_enumeration_eligible`, and `source_tape_eligible`, while keeping clock `qualified` strictly all-fresh with `source_reconstruction_accepted`.
- [ ] 9.4 Bind the complete expected and observed provider-object/selected-interval inventory so source-event enumeration eligibility is positively proved rather than inferred from missing defects.
- [ ] 9.5 Refactor the policy-neutral OKX top-100 state/freshness-change runner from repository-only Candidate tooling into the server-independent published `market-data-source-tape/v1` package-library subpath; implement the closed pair/window input and normalized invocation hash without a required clock, third executable, thirteenth schema, Maker policy filtering, or broker/server import.
- [ ] 9.6 Rename Candidate-specific tape construction/capability identities to role-neutral source-tape identities and regenerate dependent policies, fixtures, and product-pin v2 so it binds the source-tape capability plus exported subpath/runtime/declaration hashes separately from exactly two executable identities; retain exactly twelve package schemas by reusing the levels and depth-summary projections only after semantic validation.
- [ ] 9.7 Remove the Maker derivation-descriptor schema copy and semantic validator from CEX qualification authority; add architecture tests proving CEX does not inspect Maker scheduler/configuration, DEX inputs, invocation mappings, blocked outcomes, or Candidate roles.
- [ ] 9.8 Keep only the generic CEX 100,000-target request ceiling and exact no-deduplication behavior; remove Maker-invocation and Candidate-capacity preflight ownership from CEX and add a deterministic package-library invocation fixture that proves Maker can call the clock-independent closed API.
- [ ] 9.9 Add adversarial tests for exact clock membership and record causality, operation-union exclusivity, rejected clock fields on source-tape input, role-neutral identical-clock behavior, source-partition and enumeration predicates, positive inventory, source-tape completeness, terminal qualification records, absent Maker semantics, and the 100,000-target whole-ledger bound.
- [ ] 9.10 Re-run unit, type, build, generated-identity, clean-extraction library/import, product-pin, package, strict OpenSpec, architecture, and secret-reflection validation; correct invalidated historical evidence claims and record remaining credential/source/Maker-owned operational work without marking it complete.

## 10. Correct the Pre-Freeze Sandbox Qualification Tooling

- [x] 10.1 Pin the disposable ClickHouse runtime to `clickhouse/clickhouse-server:24.8.14.39@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b` and bind the resolved image identity plus reported `24.8.14.39` server version in the bundle manifest.
- [ ] 10.2 Replace provider-object state accumulation with true reconstructor-level bounded yielding: at most four complete states before downstream backpressure, 1,000 rows and 5,242,880 JSON bytes per forwarder batch, exactly one in-flight submission, and acknowledgement before the next provider object is read.
- [x] 10.3 Enforce exactly one initialization/support state, permit it before the fixed window, include only changes in `[start, end)`, and add exclusive-end and cross-object boundary tests.
- [ ] 10.4 Route tape rows through the disposable sandbox's normal archive-forwarder, promotion, qualification, exact-selection, replay-qualified-view, and exporter-v2 path; calculate streaming expected-versus-ClickHouse semantic digests plus real boundary/seam/coverage proofs, and reject asserted booleans, empty boundary digests, count-only equivalence, or a qualification-only Parquet writer.
- [ ] 10.5 Replace the CEX atomic two-pair verdict with pair-local durable finalization: once a safe attempt directory exists, every thrown or invalid source-tape outcome atomically commits the `source_tape` qualification-record-v1 failure branch with a stable reason and partial-evidence hashes, no successful exporter/Parquet descriptor, and no stale success; make the success branch reference exporter result v2, keep pair-prefixed paths, and leave aggregation to Maker.
- [x] 10.6 Prove the harness uses the request's exact authorization ID and `sandbox/cex-archive-local` target while retaining the stable `production` mutation-authorization class without bypass or weakening.
- [x] 10.7 Add release-freeze validation that rejects dirty/non-frozen checkouts and evidence whose package version, git head, tag, or registry `gitHead` differs; leave version reservation, merge, live gates, tag, publish, registry audit, and Maker registry adoption pending.
- [ ] 10.8 Re-run targeted adversarial RED/GREEN tests, repository unit suite, type/build, changed-file formatting, strict OpenSpec validation, package audit, ClickHouse smoke, and secret-reflection checks without licensed live qualification or publication.
