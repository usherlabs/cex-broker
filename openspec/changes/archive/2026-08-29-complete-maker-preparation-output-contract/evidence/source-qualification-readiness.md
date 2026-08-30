# Source Qualification Readiness — 2026-08-26

> **Historical checkpoint:** The verified repository command outcomes in this
> document remain evidence for commit
> `3481f4e386c349af748684b87f9b2a50695141fe`, but later probes invalidated its
> reconstructor-bound and universal-verdict readiness claims. Its operator
> sequence is superseded by
> `ownership-boundary-reassessment.md`. Do not reserve a successor version or
> freeze release identity until the reopened role-neutral boundary and
> pre-freeze conformance tasks are complete.

## Current gate

The CEX-owned deterministic implementation and disposable sandbox tooling are
partially implemented but are not pre-freeze ready. The reopened role-neutral
library, contextual evidence, bounded reconstruction, semantic archive, and
pair-local terminal-result tasks remain pending, as do live qualification,
release, registry audit, and Maker consumer proof. No successful live source
qualification, production promotion, publication, or Maker acceptance is
claimed here.

The fixed 24-complete-UTC-day half-open window remains
`[2026-07-26T00:00:00Z, 2026-08-19T00:00:00Z)`.

| Candidate A bootstrap pair | Targets | Clock ID | Required-clock SHA-256 |
| --- | ---: | --- | --- |
| ARB-USDC | 2,808 | `b112ca68-fe37-56b5-b510-e2c10fbdeaf7` | `de6f9c589a08358978d442601b28bec9af6a3c2c84427007762d499a7a1b4d48` |
| ARB-USDT | 932 | `73a3eed5-fbc5-533f-ac39-db07640b245a` | `646e252907ebc1d3d2cd6dab2984982503588955b748a0b14fa1ea788a23a538` |

Maker documentation classifies these as Candidate A bootstrap clocks rather
than its final `nominal_policy_opportunity_clock`. That classification and any
ordering between Maker clocks remain Maker-owned. The CEX source-tape operation
does not accept these clocks; if Maker later submits either through the generic
required-clock interface, CEX treats it role-neutrally.

## Exact Maker inputs

The earlier statement that the clock sidecars were absent is superseded. The
exact files remain in Maker's gitignored thesis workspace:

- ARB-USDC:
  `/home/azureuser/ao-repos/fiet-maker-develop/.emdash/worktrees/fiet-maker-ao/ed/fiet-990-7boz6/.backtest/hb-runs/fiet-990-fiet-1043-okx-reference-arb-dual-20260824/qualification/reference-depth-clock-qualification-20260825-v2/arb-usdc/required-clock.json`
- ARB-USDT:
  `/home/azureuser/ao-repos/fiet-maker-develop/.emdash/worktrees/fiet-maker-ao/ed/fiet-990-7boz6/.backtest/hb-runs/fiet-990-fiet-1043-okx-reference-arb-dual-20260824/qualification/reference-depth-clock-qualification-20260825-v2/arb-usdt/required-clock.json`

Their raw file SHA-256 values were rechecked on 2026-08-26 as
`9c7adeaac45d7f0292f0692ffe3d93342d820955a726fecfa1431809a44b6e0f`
and
`27405c43541f1eb1a187ec0749760179c0d0149f7fe9d0d326572ac7511f8e11`
respectively. Matching request, projection, Maker-policy-event, DEX lineage,
and qualification-manifest files remain beside them. They must be transferred
as one content-addressed external evidence bundle; hashes alone do not
authorize regenerating different bytes.

The last retained Candidate A source result is historical failed evidence, not
a fresh verdict:

- ARB-USDC: 832 failed targets, including 549 unanchored targets and 20
  sequence gaps;
- ARB-USDT: one target with 107,794 ms lag;
- future-state targets: zero;
- the strict prior-as-of ceiling remains 5,000 ms.

Fresh clock-qualification ledgers must classify every submitted target as fresh, positively
inactive, or disqualifying. Proven inactivity is retained in the fixed-window
Maker timeline as `reference_depth_stale`; it does not authorize a shifted
window, stale CEX depth, or vendor escalation. Any disqualifying or
contradictory evidence remains failed.

## Historical CEX tooling checkpoint

The repository now contains separate, repository-only boundaries for:

1. bounded Candidate A/C source-forensics and qualification evidence;
2. full-window CryptoHFTData provider-object enumeration;
3. a source-complete policy-neutral top-100 OKX state/freshness-change stream;
4. bounded archive-forwarder submission with one in-flight batch;
5. the normal sandbox-local promotion, current receipt, qualification,
   replay-qualified exact selection, and exporter-v2 path;
6. pair-prefixed paths plus a repository-only two-pair harness whose thrown
   failure path was not durable and whose aggregate ownership is superseded by
   Maker-owned orchestration; and
7. release-freeze validation across package version, merge commit, tag, and
   registry `gitHead`.

The disposable archive target is exactly `sandbox/cex-archive-local`. Its
runtime is pinned to
`clickhouse/clickhouse-server:24.8.14.39@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b`
and validates reported server version `24.8.14.39`. The forwarder's stable
`production` scope remains the existing mutation-authorization class; it is
not a production-environment claim and is not weakened.

## Gates that remain

- Complete reopened OpenSpec sections 9 and 10, including the closed
  `market-data-source-tape/v1` package API, operation-specific ledger/
  qualification-record union, role-neutral capability/product pins, true
  reconstructor yielding, semantic archive proof, and pair-local terminal
  commits.
- Have Maker prove deterministic import and invocation of the product-pinned
  source-tape library and its ownership of cross-stage/cross-pair orchestration
  without live credentials.
- Query npm and reserve an unused successor version.
- Commit all implementation and generated identities, merge PR #155, and
  freeze the exact clean merge commit before identity-bound evidence.
- Retrieve the licensed provider credential through the approved Vault path
  without printing or persisting it.
- Have Maker invoke pair-local CEX source-tape preparation over the fixed window
  from the frozen commit without supplying a required clock or Candidate role.
- Remediate CEX adapter defects or escalate only classifications that actually
  prove provider corruption, row loss, or mutable bytes.
- Have Maker materialize and capacity-preflight its untruncated policy clocks
  from the eligible tape, then submit each through the role-neutral CEX
  required-clock interface; more than 100,000 CEX targets requires a
  specification decision before request construction.
- Run exhaustive role-neutral dispositions and strict admitted-clock
  qualification while Maker alone validates its derivation descriptors,
  invocation mappings, blocked outcomes, and aggregate verdict.
- Tag and publish the exact frozen commit, audit an independent registry
  download, then have Maker adopt that registry product and final product pin.
- Land immutable evidence through a follow-up evidence PR.

The local sandbox runtime needs no production ClickHouse or archive-forwarder
credentials. Publication credentials and Maker-owned materialization remain
outside this implementation phase. Live qualification remains opt-in and the
licensed conformance probe correctly fails closed unless explicitly enabled.

## Deterministic verification

- repository suite: 979 tests, 0 failures, 3,045 expectations across 106 files;
- TypeScript: passed;
- build and Node package import/construction: passed;
- changed-file Biome and `git diff --check`: passed;
- strict OpenSpec validation: passed;
- historical package extraction audit: passed for local candidate `0.2.50` with
  two bins and twelve schemas, but it did not verify the final role-neutral
  source-tape library entry, declaration, capability, or terminal-record union;
  task 9.10 must rerun it. The diagnostic tarball SHA-256 was
  `25390a8b5fe355bc4f53068d5e11828e57b87907a6d3d03efa994797a6b0de40`;
- pinned disposable ClickHouse bootstrap, archive schema/identity,
  authorization preflight, and cleanup: passed.

The package version and local tarball hash are diagnostic only. They are not a
reserved successor version, registry product pin, or release evidence.
