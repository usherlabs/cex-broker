## REMOVED Requirements

### Requirement: Final v1 wire artifacts are strict and cross-language canonical

**Reason**: CEX no longer publishes a vendor-backfill wire or preparation artifact.

**Migration**: Maker SHALL define and own any cold-source wire contract it needs without importing a CEX runtime package.

### Requirement: Request policy is caller-resolved and deployment details stay private

**Reason**: The request policy belongs to the removed CEX vendor acquisition service.

**Migration**: Move vendor selection and request policy to Maker's sourcing boundary.

### Requirement: Archive preflight returns an exact content-addressed selection

**Reason**: CEX no longer preflights or selects historical vendor archives.

**Migration**: Maker SHALL resolve vendor-object segments directly and record its own content identities.

### Requirement: Full receipt identity and semantic promotion identity are distinct

**Reason**: Receipt promotion is not part of the CEX live/hot archive.

**Migration**: Export any required CEX audit evidence, then remove promotion objects; Maker MAY model its own cold evidence independently.

### Requirement: Closed CEX outcomes match durable job ownership

**Reason**: The CEX-owned vendor job and its outcome state machine are deleted.

**Migration**: Stop all workers before the breaking release and move required job ownership to Maker.

### Requirement: Backfill contracts are versioned, deterministic, and secret-free

**Reason**: There is no supported CEX backfill contract after the live/hot cutover.

**Migration**: Remove package schemas and callers; version any new Maker-owned contract in Maker.

### Requirement: Worker execution has one reusable core API and closed outcomes

**Reason**: The reusable worker core exists solely for the removed vendor preparation product.

**Migration**: Delete it from CEX; port independently useful algorithms to Maker rather than preserving a CEX dependency.

### Requirement: Dispatch is qualified-archive-first and capability-before-credentials

**Reason**: Qualified historical archive dispatch is no longer a CEX responsibility.

**Migration**: Maker SHALL own cold-source dispatch and credential resolution.

### Requirement: CryptoHFTData acquisition is bounded and provider-truthful

**Reason**: CryptoHFTData acquisition belongs to Maker/FIET-1015, not CEX Broker.

**Migration**: Remove the CEX adapter and use Maker's direct vendor-object reader.

### Requirement: Vendor snapshot and update events reconstruct deterministic top-N books

**Reason**: Historical reconstruction is outside the CEX live/hot boundary.

**Migration**: Port required reconstruction and fidelity evidence to Maker and delete the CEX implementation.

### Requirement: Archive submission is chunked, retryable, and idempotent

**Reason**: CEX SHALL reject historical archive submission rather than expose a backfill ingestion path.

**Migration**: Stop submissions, deploy explicit `external_backfill` rejection, and remove the client and route.

### Requirement: FIET-1017 promotion is semantic and commits qualification last

**Reason**: Promotion and qualification are removed from CEX.

**Migration**: Preserve any required audit export before terminally dropping promotion and qualification objects.

### Requirement: Maker consumer proof remains independently bound

**Reason**: The proof binds Maker to the deleted CEX preparation artifact.

**Migration**: Maker SHALL own cold-reader and policy proof; CEX retains only shared-wire Proof C and the summary-v2 fixture/query boundary.
