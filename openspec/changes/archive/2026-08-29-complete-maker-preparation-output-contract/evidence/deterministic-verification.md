# Deterministic verification evidence

Recorded on `2026-08-26` from branch
`ed/famous-sails-battle-fxc0c` at commit
`8206ad4d73f5f2cfd32012d648b29db6b7ee3134` plus the uncommitted
OpenSpec implementation. This is pre-freeze engineering evidence only.

> **Historical checkpoint:** The commands and results below remain evidence of
> the recorded implementation state. Their Candidate-named architecture and
> release next steps are superseded by
> `ownership-boundary-reassessment.md`; no version may be reserved until the
> reopened role-neutral boundary and pre-freeze conformance tasks are complete.

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

## Candidate C and sandbox gates

- Full-window OKX object enumeration is independent of sparse Candidate A
  targets.
- Tape reconstruction streams at most four states per yield, submits at most
  1,000 rows and 5,242,880 JSON bytes per forwarder batch, permits exactly one
  in-flight submission, and waits for acknowledgement before the next provider
  object.
- Deterministic tests cover the sole initialization state, changes in
  `[start, end)`, the exclusive end boundary, cross-object sequencing, and a
  change omitted by Candidate A sampling.
- The sandbox path uses the normal archive forwarder, promotion receipt,
  qualification event, replay-qualified exact selection, and exporter-v2
  identities. The public Maker/backfill request does not acquire the
  qualification-only tape construction mode.
- Pair artifacts are pair-prefixed. A second-pair failure cannot overwrite the
  first pair, and its durable verdict retains the first pair manifest/artifact
  hashes plus the failing pair's partial-evidence hashes. Stale opposite
  top-level verdicts are removed.
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
- Pair failure removes that pair's Parquet and manifest and commits a stable
  top-level verdict; failure is not represented only by missing success.

## Operational gates intentionally not claimed

OpenSpec tasks 8.1–8.15 remain pending. Their required order is:

1. reserve an unused npm successor;
2. commit all bytes and identities, merge PR #155, and freeze the exact clean
   merge commit;
3. run deterministic and live Candidate A/C gates from a clean checkout of
   that commit;
4. tag and publish that exact commit;
5. independently audit registry bytes and derive the registry product pin;
6. have Maker adopt the registry product and repeat final consumer proof; and
7. land immutable evidence through a follow-up evidence PR.

Any package-byte or `gitHead` change invalidates identity-bound live evidence.
No live source qualification, tag, publication, registry audit, production
deployment, or Maker consumer proof is asserted by this record.
