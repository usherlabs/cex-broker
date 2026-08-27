# Deterministic verification evidence

Recorded on `2026-08-26` from branch
`ed/famous-sails-battle-fxc0c` at commit
`8206ad4d73f5f2cfd32012d648b29db6b7ee3134` plus the uncommitted
OpenSpec implementation. This is pre-freeze engineering evidence only.

> **Historical checkpoint with invalidated assertions:** The command outcomes
> below remain evidence of the recorded implementation state, but later direct
> probes disproved the claimed reconstructor-level four-state bound and universal
> durable two-pair failure verdict. Those statements are corrected below rather
> than retained as passing evidence. Candidate-named architecture and release
> next steps are superseded by `ownership-boundary-reassessment.md`; no version
> may be reserved until the reopened role-neutral boundary and pre-freeze
> conformance tasks are complete.

## Bounded live source-tape diagnosis after the package-boundary gate

On `2026-08-27`, a credentialed one-minute ARB-USDT probe against the real
provider, local archive-forwarder, and local ClickHouse exposed two defects
after the clean-extraction gate. The corrections are isolated on
`ed/fiet-1043-source-tape-forwarder-admission` at
`0a5b4fdeb72c5f01d718e2486211c64725984404` and remain unpublished.

First, the role-neutral tape used deployment and construction identities that
the production forwarder validator did not admit. The forwarder now accepts
the stable external-backfill deployment with either the sampled snapshot or
role-neutral state-change construction mode, applies that same validator to
candidate, promotion, and qualification batches, and classifies a rejected
submission durably as `source_tape_archive_failed`.

After that repair, the complete packaged operation acquired and reconciled all
169 expected provider objects, emitted 225 states, forwarded 45,000 level rows
and 225 summary rows in 114 acknowledged batches, passed streaming semantic
verification, and committed a current promotion receipt and qualification
event. It then committed the expected failure branch with
`source_tape_selection_failed`; no exporter or Parquet success descriptor was
retained.

The selection defect was a mismatch between two valid boundaries. The
source-tape operation accepts no required clock, while the shared selection
resolver required one and selected bundles only through required-clock support
anchors. Its invocation-bound zero-target reference could therefore authorize
neither selection context nor the just-promoted bundle. The corrected resolver
uses that existing zero-target reference only for source-tape selection,
requires one full-window current receipt whose request ID and idempotency key
match the exact invocation, excludes unrelated qualified bundles, and rejects
ambiguity. It does not synthesize a Maker clock or change ordinary
required-clock selection.

A read-only replay of the corrected selector against the exact promoted live
rows returned `coverage_class = complete`, selected only capture bundle
`39bc6dc9399b274ed5d99c21e1ed1b078fb4be6d9d310f08db08160cb391a917`,
bound receipt
`11f1be76f31239579ae3a662552b6ba7a84dc72827a9d4f6eff62a88dfbfed65`
and qualification event `d2c191ec-8d3a-5e50-81dd-8a6bece74fce`, and retained
an event count of zero with no support anchors. Focused selection, preparation,
sandbox, and forwarder tests passed 20/20; the full repository suite passed
986 tests with zero failures and 3,067 expectations. TypeScript and changed-file
Biome checks passed.

This bounded proof does not complete task 8.3 or claim a successful full
package operation after the selector correction. The requested 20-to-30-day
dual-pair run was intentionally not launched because the current acceptance
requirements are operationally and logically inconsistent:

- The observed tape emitted 225 full depth-100 states per minute. Linear
  projection yields 6.48 million states and 1.296 billion level rows per pair
  over 20 days, or 9.72 million states and 1.944 billion level rows per pair
  over 30 days.
- The two observed one-minute bundles occupy approximately 6.3 MB compressed
  across level and summary tables, or about 3.15 MB per bundle. Linear
  projection is approximately 85 GiB per pair for 20 days and 127 GiB per pair
  for 30 days, before exports, temporary parts, merge overhead, or the second
  pair. The host had 41 GiB free at diagnosis time.
- Even a one-second Maker policy cadence produces 1,728,000 targets over 20
  days and 2,592,000 over 30 days. Both exceed the unchanged 100,000-target
  ceiling before source-tape changes are added. Therefore an untruncated
  20-to-30-day nominal clock cannot pass task 8.5 under the current ceiling by
  construction.

No full-window source acquisition, second-pair acquisition, version change,
tag, publication, or registry adoption was performed. Tasks 8.3 through 8.15
remain open pending an explicit specification decision on clock partitioning or
the target ceiling and on bounded source-tape storage/materialization.

## Self-contained dependency-boundary repair

The superseding package-boundary run was completed on `2026-08-27` from clean
base commit `5f9d7f14fcddf576dd808dae3097ade8981a1f4c` plus the current
uncommitted OpenSpec implementation. Maker's prior clean-extraction attempt
correctly exposed that importing the broad vendor runtime required an absent
bare `zod` dependency. The supported preparation subpath now exports
`createMarketDataSourceTapeDependencies`; Maker no longer needs to import that
broad runtime or assemble the CEX forwarder, qualified ClickHouse
query/selection reader, or exact exporter.

The clean-extraction package audit now proves all of the following from the
unpacked npm tarball with no `node_modules`, sibling checkout, or repository
runtime import:

- the factory, its declaration, and both unchanged operation symbols import;
- factory construction with inert endpoint/credential configuration performs
  no network access;
- a missing provider credential commits pair-local
  `source_tape_credentials_missing` before any dependency-boundary request;
- an inert local package fixture positively exercises the composed forwarder
  authorization preflight and submission, ClickHouse query client, and exact
  packaged exporter process;
- the preparation runtime has no non-Node bare runtime imports; and
- exactly two preparation operations, two preparation executables, and twelve
  schemas remain. The factory is a support symbol and changes none of those
  identities.

Verification results:

- `bun test --max-concurrency 1 test`: 984 passed, 0 failed, 3,050
  expectations across 103 files;
- focused preparation/contract/source-tape package suites: 29 passed, 0
  failed, 154 expectations;
- TypeScript, product build, changed-file Biome, `git diff --check`, and strict
  OpenSpec validation: passed;
- `bun run test:package:market-data-preparation`: passed twice with stable
  diagnostic tarball SHA-256
  `30396e8204b2271444634432ba2e1ec90c9731102f8de87c294a0e8587c1bc43`;
- built preparation runtime SHA-256:
  `456a9a2b80e7b86018725f9074e9d586eac44eea61a0b77672db383833993cb5`;
  and
- built preparation declaration SHA-256:
  `a478a84c63d7c2150c9fd7fe6da3638ac07653f9a3ced8e8de94febbad213605`.

The package remains the diagnostic unpublished `0.2.50` candidate. The
runtime/declaration changes regenerate candidate product-pin inputs but do not
change the role-neutral capability policy, resource policy, operation IDs, or
twelve schema identities. No successor version was reserved and no live
credential, source qualification, merge freeze, tag, publication, registry
audit, or Maker registry-consumer proof was performed.

## Maker clean-extraction acceptance

On 2026-08-27, Maker repeated the pre-freeze consumer gate against clean
committed CEX Broker head
`06276a3e79a1b030539cd5e11a9c9531ae45f910`. A fresh build and two
independent `npm pack --ignore-scripts` runs produced byte-identical local
candidate archives with SHA-256
`0df734d7015ca193c33d1ccadcc14c9f028aa4c4656284b8a0f7cfe3252f05e0`;
the CEX clean-extraction package audit passed against the same bytes.

Maker consumed only the extracted
`@usherlabs/cex-broker/market-data-preparation` subpath and its exported
`createMarketDataSourceTapeDependencies` factory. It invoked both role-neutral
operations for ARB-USDC and ARB-USDT from relocated attempt roots under Node
22.22.2, retained its own cross-stage and cross-pair state, and validated the
closed terminal-result union. The live-composition probe used inert endpoints
and no provider credential; it committed the CEX-owned missing-credential
result without a network request. No sibling checkout, repository-only helper,
Maker-owned provider reconstruction, or Maker-owned archive-write path was
admitted.

The Maker evidence binds the CEX preparation runtime SHA-256
`456a9a2b80e7b86018725f9074e9d586eac44eea61a0b77672db383833993cb5`,
declaration SHA-256
`a478a84c63d7c2150c9fd7fe6da3638ac07653f9a3ced8e8de94febbad213605`,
and conformance evidence self-hash
`352d8332b90fa894742dfa7d8210dbedc56532c8d19e54aedbc3c781d339b4e4`.
Its focused regression set passed 183 tests and its complete configured
strategies suite passed 1,191 tests with one skip. CEX task 8.1 is therefore
complete.

The package remains the unpublished diagnostic version `0.2.50`, and Maker's
local product pin remains a conformance-only preview with
`publication_claim = false`. This record does not claim an unused successor,
frozen release head, credentialed selected-window run, tag, publication, or
registry adoption. Task 8.2 is the next gate.

## Role-neutral post-amendment verification

The superseding deterministic run was completed on `2026-08-26` from base
commit `4fec8b8f653c1d3e5f36fc8866d7a4fc4cb1d5c8` plus the current uncommitted
OpenSpec implementation:

- `bun test --max-concurrency 1 test`: 982 passed, 0 failed, 3,045
  expectations across 103 files;
- focused operation/forensics/tape suite: 69 passed, 0 failed, 189
  expectations;
- TypeScript, build, Node package import/construction, all changed-file Biome
  checks, `git diff --check`, and strict OpenSpec validation: passed;
- clean tarball extraction imported and invoked both role-neutral operations
  without a sibling checkout or credential and observed durable terminal
  qualification records;
- the unpacked package retained exactly two preparation executables, twelve
  schemas, one role-neutral source-tape capability, and the exact two-symbol
  preparation-library ABI;
- independent Python verification reproduced the role-neutral operation
  fixture, policy, schema, result, and product-pin identities; and
- a credential-free disposable runtime smoke resolved the pinned ClickHouse
  image digest, reported `24.8.14.39`, initialized the sandbox archive,
  completed exact authorization preflight, and cleaned up.

The diagnostic local package remains `0.2.50`; its current tarball SHA-256 is
`5b8fef3ca0329843f756c89e15137ec441d941dd5110d6187224455563c4fda9`.
It is not a reserved successor version or registry product. The licensed
provider smoke was deliberately not enabled, and no live provider bytes,
publication, or Maker acceptance are claimed. Repository-wide Biome still
reports unrelated pre-existing unused-variable diagnostics outside the change;
every changed and newly added TypeScript/JSON file passes.

## Repository and contract gates

- Bun `1.3.12`; Node `v22.22.2`.
- `bun test test`: 979 passed, 0 failed, 3,045 expectations across 106
  files.
- `bun run build`: passed, including protobuf generation, product build,
  declarations, package copies, and Node package import/construction.
- `bunx tsc --noEmit`: passed.
- Biome checked all changed and untracked TypeScript/JSON files after applying
  safe formatting fixes.
- `openspec validate complete-maker-preparation-output-contract --strict
  --no-interactive`: passed.
- `git diff --check`: passed.

## Historical Candidate C and sandbox observations

- Full-window OKX object enumeration is independent of sparse Candidate A
  targets.
- The downstream writer split an already accumulated provider-object state array
  into four-state chunks. It did **not** prove reconstructor-level bounded
  yielding: the reconstructor retained every state for one provider object until
  `push()` completed. OpenSpec task 10.2 is therefore reopened. The separate
  1,000-row, 5,242,880-byte, one-in-flight forwarder limits remain implemented
  but require re-verification after the reconstructor fix.
- Deterministic tests cover the sole initialization state, changes in
  `[start, end)`, the exclusive end boundary, cross-object sequencing, and a
  change omitted by Candidate A sampling.
- The sandbox path uses the normal archive forwarder, promotion receipt,
  qualification event, replay-qualified exact selection, and exporter-v2
  identities. The public Maker/backfill request does not acquire the
  qualification-only tape construction mode.
- Pair artifacts are pair-prefixed, but a thrown `runPair()` path escaped before
  committing the top-level verdict. The prior test covered returned failures,
  not every thrown outcome, so it did **not** establish universal durability.
  Aggregate two-pair finalization is now Maker-owned; CEX task 10.5 must prove a
  terminal qualification-record-v1 result independently for each pair.
- Release-freeze tests reject dirty or mismatched package-version, merge-head,
  tag, and registry-`gitHead` inputs.

## Pinned local runtime

The disposable runtime bootstrap was executed without provider credentials:

- image:
  `clickhouse/clickhouse-server:24.8.14.39@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b`;
- resolved image ID:
  `sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b`;
- reported server version: `24.8.14.39`;
- archive schema and `sandbox/cex-archive-local` identity: initialized;
- forwarder preflight: accepted the exact request authorization ID while
  preserving stable mutation-authorization class `production`;
- cleanup: endpoint, client, container, and temporary exporter directory
  removed.

No CryptoHFTData object was fetched and no live qualification was run.

## Preparation package gate

`bun run test:package:market-data-preparation` passed for the local diagnostic
candidate `@usherlabs/cex-broker@0.2.50`, including clean extraction, two
preparation executables, twelve schemas, manifest v3, current policies,
standalone execution, and existing `cex-broker` compatibility. The local
tarball SHA-256 was
`25390a8b5fe355bc4f53068d5e11828e57b87907a6d3d03efa994797a6b0de40`.

That version and hash are not release evidence. No successor version was
reserved and no registry bytes were used.

## Secret and failure gates

- Existing repository and new qualification tests cover reflected secrets,
  result/log/evidence projection, bounded forensic retention, licensed-row
  cleanup, mutable bytes, corruption, row loss, gaps, future state, and
  contradictory evidence.
- The licensed-provider conformance command was invoked without live enablement
  and failed closed with its explicit opt-in error, as designed.
- Some returned pair failures removed Parquet/manifest output and committed a
  stable verdict, but direct throws could leave failure represented only by
  absence. This assertion is invalidated and replaced by reopened pair-local
  qualification-record finalization task 10.5.

## Operational gates intentionally not claimed

OpenSpec tasks 8.1–8.15 remain pending. Their required order is:

1. complete the reopened role-neutral package and pre-freeze conformance tasks,
   including deterministic Maker invocation without live credentials;
2. reserve an unused npm successor, commit all bytes and identities, merge PR
   #155, and freeze the exact clean
   merge commit;
3. let Maker invoke pair-local CEX source-tape preparation and submit its
   independently derived clocks through the role-neutral required-clock API;
4. complete pair-local source, archive, and export gates plus Maker's aggregate
   and consumer proof from that frozen commit;
5. tag and publish that exact commit;
6. independently audit registry bytes and derive the registry product pin;
7. have Maker adopt the registry product and repeat final consumer proof; and
8. land immutable evidence through a follow-up evidence PR.

Any package-byte or `gitHead` change invalidates identity-bound live evidence.
No live source qualification, tag, publication, registry audit, production
deployment, or Maker consumer proof is asserted by this record.
