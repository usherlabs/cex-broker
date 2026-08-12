import { createHash } from "node:crypto";

/**
 * Per-(batch, table) ClickHouse insert deduplication token.
 *
 * A sender that retries a failed batch re-posts every table in it, including
 * tables whose insert already succeeded before a sibling table failed — the
 * forwarder commits per table and has no cross-table transaction to roll back.
 * A token stable across those retries is what stops the re-post from landing a
 * second copy: ClickHouse skips an insert whose token it has already seen
 * within the table's non_replicated_deduplication_window.
 *
 * The token is derived rather than sent so a sender only has to keep one batch
 * identity stable, and so two batches can never collide on a table by accident.
 */
export function archiveDedupeToken(batchId: string, table: string): string {
	return createHash("sha256")
		.update(`maker-archive-forwarder-v1\0${batchId}\0${table}`)
		.digest("hex");
}
