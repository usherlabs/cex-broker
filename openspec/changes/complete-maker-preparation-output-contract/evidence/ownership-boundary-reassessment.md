# Preparation Ownership Boundary Reassessment

## Checkpoint

This reassessment is based on clean CEX Broker commit
`3481f4e386c349af748684b87f9b2a50695141fe`. At that checkpoint the declared
repository suite passed with 979 tests, 0 failures, and 3,045 expectations, and
the OpenSpec task list reported 70/85 complete. No successor version, live
CryptoHFTData qualification, release freeze, tag, publication, or Maker
consumer proof had occurred.

The deterministic checkpoint remains valuable, but it is not release-ready.
The specification now reopens pre-freeze work for accepted conformance defects
and corrects an ownership drift in repository-only qualification tooling.
Version reservation MUST remain blocked until the reopened work is complete.

> **Superseding status, 2026-08-26:** the CEX-owned reopened work in sections 9
> and 10 is now complete and deterministically verified in the current
> uncommitted working tree. Version reservation remains blocked by task 8.1
> until Maker proves clean-extraction invocation and its ownership of the
> cross-stage/cross-pair state machine; this document still records why the
> ownership boundary changed.

## Preserved CEX Data-Plane Scope

The following completed architecture remains CEX-owned and is not discarded:

- CryptoHFTData acquisition and OKX snapshot/update interpretation;
- sequence, anchor, provider-object, inactivity, and corruption forensics;
- policy-neutral top-100 state/freshness-change reconstruction;
- forwarder-mediated sandbox archive, promotion, receipt, exact selection,
  replay-qualified view, and exporter-v2 processing;
- immutable ClickHouse 24.8.14.39 image and server identity;
- pair-scoped Parquet paths and physical projection validation;
- exact sandbox mutation authorization semantics;
- release-freeze identity validation; and
- current-policy package, schema, and product-pin generation foundations.

## Ownership Corrections

| Concern | Normative owner after amendment | CEX responsibility |
|---|---|---|
| Vendor acquisition and venue reconstruction | CEX | Full implementation and evidence |
| Source-complete policy-neutral tape | CEX | Pair-local package-library operation and immutable artifacts |
| Required-clock qualification | CEX | Exact role-neutral clock, target partition, and source evidence |
| Candidate A/B/C roles | Maker | CEX treats each supplied clock identically |
| DEX/scheduler/policy materialization | Maker | No CEX semantic validation |
| Target-to-Maker-invocation mapping | Maker | CEX counts and qualifies CEX targets only |
| Admitted clock and `reference_depth_stale` | Maker | CEX returns source dispositions |
| Capacity preflight before request construction | Maker | CEX independently enforces its received-target ceiling |
| Atomic ARB-USDC/ARB-USDT verdict | Maker | CEX commits one durable result per pair |
| ClickHouse `market_data` mutation | CEX archive-forwarder | Maker receives no direct write authority |

Maker supplies one operator-facing workflow and may invoke the pinned CEX
package-library operation in a local Node process or sidecar beside the
emulator. Process placement does not transfer source or archive authority.

## Accepted Pre-Freeze Findings

| Finding | Amended disposition |
|---|---|
| Four-state bound | Remains a CEX blocker. Yielding must be bounded inside the reconstructor before provider-object accumulation. |
| Clock partition proof | Remains a CEX blocker. Validation must use the authoritative required clock and prove exact target membership plus record-interval causality. |
| Maker descriptor binding | Removed from CEX authority. Maker validates its scheduler, DEX, policy, mapping, and blocked-outcome descriptor semantics. |
| Durable verdict | Split by boundary. The operation-specific qualification-record-v1 branch is CEX's terminal source-tape result for every pair attempt after a safe attempt directory exists; Maker guarantees the aggregate two-pair verdict. |
| Candidate A binding | Generalized. CEX binds the exact request and required clock without interpreting a Candidate role. |
| Tape semantic verification | Remains a CEX blocker. Actual semantic digests, source inventory, seams, and coverage must replace counts, empty boundary digests, or asserted booleans. |
| Tape invocation/evidence circularity | Remains a CEX blocker. The closed source-tape package API and its ledger/qualification-record branch bind pair/window source evidence without accepting or inventing a required clock. |
| Tape release identity | Remains a CEX blocker. Product pin v2 must bind the role-neutral source-tape capability plus runtime/declaration hashes separately from the exactly two executable identities. |

Candidate bootstrap and admitted-clock qualification may remain separate steps
in Maker's state machine. CEX sees only independent, content-addressed
required-clock requests and produces role-neutral evidence for each.

## Release Consequence

The previous next action—reserve a successor version and freeze release
identity—is superseded. The ordered boundary is now:

1. apply the role-neutral CEX package-library and pair-local finalization changes;
2. close all accepted CEX conformance findings;
3. prove Maker can orchestrate the package deterministically without live
   credentials or a CEX repository checkout;
4. reserve the successor version and freeze the exact release commit;
5. run pair-local live CEX preparation under Maker orchestration;
6. publish and independently audit the registry product; and
7. have Maker repeat its full consumer proof against registry bytes.

No implementation, release, or live qualification claim is made by this
reassessment.
