## Why

Fiet Maker needs immutable, bounded preparation products that can acquire missing
historical market data and export an exact qualified archive selection without a
sibling checkout or a Fiet-owned host wrapper. The released CEX Broker package
owns the domain logic but still publishes only a library and a broad operator
export script, while its durable result incorrectly identifies a Fiet TEE build.

## What Changes

- Publish `market-data-vendor-backfill` and
  `cex-canonical-orderbook-export` as separate self-contained Node 22 npm bins
  with the closed `run --request <path> --result <path>` interface.
- Publish market-data-vendor-backfill result v2 with CEX producer, package,
  executable, release-git-head, and Node runtime identities instead of Fiet TEE
  provenance or build timestamps.
- Preserve every v1 schema, fixture, codec, policy, and package export while
  adding a preparation schema manifest v2, exporter request/result v1 schemas,
  and a closed Maker-facing preparation product-pin schema.
- Replace broad bundle/window export in the packaged product with exact
  per-bundle/per-interval qualified queries, checksum-conflict rejection,
  authoritative-window exclusivity, and fill-gaps archive-wins precedence.
- Detect relevant checksum conflicts during archive-selection preflight so a
  conflicted archive cannot be classified as a vendor-acquisition miss.
- Audit and publish the two executable artifacts in
  `@usherlabs/cex-broker@0.2.47`, then record immutable registry, executable,
  schema, and policy identities for Maker.
- Correct the repository architecture contract: CEX Broker owns the bounded
  preparation executables; Maker owns independent post-export loader and
  required-clock proof. Fiet TEE owns neither product.

## Capabilities

### New Capabilities

- `cex-market-data-preparation-executables`: Defines the standalone file-job,
  exact canonical exporter, versioned producer identity, product pin, and
  extracted-tarball execution contracts.

### Modified Capabilities

- `market-data-vendor-backfill`: Changes the durable executable result from the
  Fiet-owned v1 envelope to a CEX-produced v2 envelope while preserving the v1
  library contract.
- `cex-order-book-replay-archive`: Requires initial conflict-aware selection and
  exact qualified per-interval export with source-policy precedence.
- `cex-broker-service-architecture`: Reassigns the bounded executable and
  release-product boundary from Fiet TEE to CEX Broker without adding a daemon,
  RPC action, collector loop, or direct ClickHouse writer.

## Impact

- Affects the backfill contract/assets and archive reader under `src/helpers/`,
  adds two `src/commands/` entrypoints, and promotes the retained Parquet export
  logic into a reusable helper.
- Adds npm bin and package-export entries, Node 22 standalone build/audit gates,
  schema/fixture assets, and release evidence for version `0.2.47`.
- Does not change `src/server.ts`, gRPC handlers, production broker startup, the
  archive-forwarder writer boundary, or Maker runtime code.
