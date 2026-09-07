# Typed package and release verification

## Public contract

Version 0.3.2 is a candidate until separately approved and published. Do not
replace immutable 0.3.1. The package is ESM, with `types` conditions before
`import` conditions. ESM library consumers need Node (validated on Node 24), not
Bun, repository source, patches, or install-time development scripts. The advertised
`cex-broker` CLI retains its existing `#!/usr/bin/env bun` shebang and requires Bun
when invoked through that executable.

The root preserves default `CEXBroker` and `PolicyConfig` and exposes the existing
canonical `Action`, `BatchChildRequestSchema`, `BatchPayloadSchema`,
`BatchResponseEntrySchema`, `BatchResponseEnvelopeSchema`, `MAX_BATCH_CHILDREN`,
`MAX_BATCH_REQUEST_BYTES`, the three venue-evidence schemas, their inferred types,
and protobuf `ActionRequest` / `ActionResponse` types. The root declaration bundle
imports only Zod. Runtime dependencies are bundled or explicitly declared; no new
server runtime export, wildcard internal exports, or alternate wire models exist.

Explicit assets:

- `@usherlabs/cex-broker/proto/node.proto`: canonical wire bytes.
- `@usherlabs/cex-broker/proto/node.descriptor`: Node-importable descriptor and types.
- `@usherlabs/cex-broker/build-metadata.json`: version, full revision, proto hash,
  four schema identities, and scoped source hashes.

Physical declarations also include `dist/helpers/constants.d.ts`,
`dist/server.d.ts`, `dist/types.d.ts`, both action schema modules, CLI, and all
generated protobuf modules. These parity/internal files are not public subpath
exports. Every public declaration and its entire dependency closure compiles with
strict NodeNext and `skipLibCheck: false`. Strict bundler resolution additionally
checks **all** physical declarations. Upstream `@usherlabs/ccxt` uses extensionless
imports in its own declarations; consequently the unexported server/types files
are not NodeNext-compatible. This is not a public API limitation, and is not hidden
by `skipLibCheck` or an upstream patch.

```ts
import {
  Action, BatchPayloadSchema, BatchResponseEnvelopeSchema,
  TradingFeeEvidenceSchema, type ActionRequest,
} from "@usherlabs/cex-broker";

const request: ActionRequest = {
  action: Action.Batch,
  cex: "mexc",
  payload: { requests: JSON.stringify([
    { id: "fees", action: Action.FetchFees, symbol: "ARB/USDC", payload: {} },
  ]) },
};
BatchPayloadSchema.parse(request.payload); // Validate without replacing the wire payload.
// Given a successful ExecuteAction response:
// const batch = BatchResponseEnvelopeSchema.parse(JSON.parse(response.result));
// Check each id/action and error before decoding its action-specific result:
// const fee = TradingFeeEvidenceSchema.parse(JSON.parse(child.response.result));
```

## Tooling layout

`build.ts` builds the package. `scripts/check-node-package.mjs` performs the
Node import smoke test, and `scripts/check-package.ts` orchestrates installed
package verification. These remain executable entry points; their commands are
unchanged.

Reusable support modules live under `scripts/lib/package/`:

- `provenance.ts`: build revision resolution and clean-release revision checks.
- `contract.ts`: required package paths, schema identities, reference source pins,
  and hashing helpers.
- `content.ts`: npm pack-output parsing and installed-package content validation.
- `consumer-environment.mjs`: environment isolation shared by the Node smoke test
  and external package verification.

The build, checks, and tests import these modules directly. They are development
tooling, not public package exports or broker runtime helpers.

## Build and isolated verification

Use Bun 1.3.14, Node 24, npm 12, and the committed lockfile. `build:ts` is a
no-emit typecheck. `build` fails on generation, typecheck, bundling, or declaration
errors and cleans only build-owned `dist`. `dts-bundle-generator` is a direct dev
dependency; the superseded declaration plugin and copy pipeline are removed.

```sh
bun install --frozen-lockfile
bun run build:ts
bun run check
bun run build
# Commit all intended source first. The verifier refuses dirty/untracked files.
OUT=$(mktemp -d /tmp/cex-broker-package.XXXXXX)
# Ordinary prepack is independently exercised; it builds once and never packs.
npm pack --pack-destination "$OUT"
bun run check:package --tarball "$OUT/usherlabs-cex-broker-0.3.2.tgz" \
  --expected-git-head "$(git rev-parse HEAD)" --output "$OUT/verified"
```

Without `--tarball`, `check:package` packs the existing build with
`--ignore-scripts`, never recursively rebuilding. It installs outside the repo
using npm with scripts disabled, validates every advertised target and required
physical declaration, canonical proto/descriptor, exact expected revision and
source hashes, then compiles the documentation example and runs an external typed
ESM consumer. Each verifier consumer receives an environment without inherited
`CEX_BROKER_` or `OTEL_` settings before package imports, so configured operator
journals, exports, credentials and telemetry cannot initialize during checks. The
build's Node import smoke applies the same cleanup before import. The packed
loopback RPC harness starts with an empty broker map and mutates that same map
only after startup. It uses no real exchange or credentials. It verifies selected
account/pair isolation, three evidence kinds, count/byte boundaries, rejection
before provider access, child-local proofs/errors, continued siblings, and ticker
secret-sentinel redaction in both logs and responses.

`package-evidence.json` records the tarball SHA-256 and SHA-512 integrity, complete
inventory and its SHA-256, version/revision, installed package path, metadata, and
source proof. Keep this evidence and tarball outside the repository. A candidate
artifact is not registry evidence and does not authorize deployment.

## Release source proof

The verifier requires a clean checkout at the expected full Git revision.
The packed build metadata must identify that revision and match the current
source hashes produced by `contractSourceHashes`. Candidate evidence records
the same revision and hashes alongside the immutable tarball's integrity.
This binds each package to its approved source without freezing later releases
to a historical implementation or maintaining source-patch exceptions.

The proto SHA-256 and evidence schema identities remain independently checked.
Packed consumer and RPC checks verify the public behavior, including
credential redaction; source hash equality is not a substitute for those checks.

## Publication boundary

CI and publish workflows pack through ordinary prepack and verify the tarball.
The publish workflow uses OIDC (`id-token: write`, npm 12) and publishes **that
same verified tgz** with `--ignore-scripts --provenance`, not a rebuilt directory.
Do not trigger it without explicit operator approval naming revision, version,
and release actions. Existing tag workflows also publish broker,
archive-forwarder, and market-data-collector Docker images; authorization must
account for those side effects. No auto-merge is enabled by this change.

For an approved **npm-only** release, manually dispatch `publish.yml` without
creating a version tag. Set `RELEASE_REF` to the approved branch and
`RELEASE_GIT_HEAD` to its approved full commit:

```sh
: "${RELEASE_REF:?Set the approved release branch}"
: "${RELEASE_GIT_HEAD:?Set the approved full Git commit}"
gh workflow run publish.yml --repo usherlabs/cex-broker --ref "$RELEASE_REF" \
  --field expected_git_head="$RELEASE_GIT_HEAD" --field publish_docker=false
```

The workflow rejects a missing, malformed, or mismatched revision before building.
Manual runs default `publish_docker` to `false`; setting it to `true` additionally
publishes the broker image and its `latest` tag, requiring separate approval.
Tag-triggered releases retain their existing image-publication behavior. The
archive-forwarder and market-data-collector workflows are separate and are not
triggered by this manual npm-only dispatch.

After approval/publication, independently retrieve the registry artifact, verify
its exact version, gitHead or attested provenance, integrity, inventory and proto
hash against approved evidence, and rerun the installed-package/consumer checks
against that tarball at the approved checkout. A registry package version query
must show 0.3.2 is unused before release; never overwrite it. Only then can
publication-dependent release criteria and the downstream adoption handoff be
finalized. Downstream contract/decoder adoption precedes coordinated deployment;
observed fees do not authorize historical schedules.
