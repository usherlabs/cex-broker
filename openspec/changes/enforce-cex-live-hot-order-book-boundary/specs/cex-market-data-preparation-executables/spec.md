## REMOVED Requirements

### Requirement: Preparation commands are standalone bounded file jobs

**Reason**: CEX no longer owns historical preparation or file-job executables.

**Migration**: Remove commands, bins, package subpaths, schemas, workflows, and documentation; move required preparation into Maker.

### Requirement: File jobs fail closed at the caller-owned attempt boundary

**Reason**: The file-job attempt boundary is deleted with the CEX preparation product.

**Migration**: Maker SHALL define fail-closed behavior for its own cold-source jobs.

### Requirement: Backfill result v2 identifies the CEX producer

**Reason**: CEX is no longer a backfill producer.

**Migration**: Reject historical CEX admission and remove the result schema and decoder.

### Requirement: Canonical export consumes an exact qualified selection

**Reason**: Both qualification and canonical Parquet export are deleted.

**Migration**: Downstream systems SHALL read the CEX hot archive directly or use Maker-owned cold objects.

### Requirement: Export result commits exact query and artifact evidence

**Reason**: No named independent CEX diagnostic consumer justifies retaining the exporter.

**Migration**: Delete the packaged exporter, script-level exporter, validator, fixtures, and result contract.

### Requirement: Product pin binds the published preparation release

**Reason**: The preparation release and its cross-repository pin are no longer published.

**Migration**: Remove the pin and publish only the final broker-supported `0.3.x` surface.
