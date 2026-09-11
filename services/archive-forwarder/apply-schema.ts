import { createClient } from "@clickhouse/client";
import { ensureArchiveSchema } from "./schema";

// A distinct executable path makes older library-only broker checkouts fail
// bootstrap instead of exiting successfully without applying any source DDL.
const url = process.env.CLICKHOUSE_URL;
if (!url) throw new Error("CLICKHOUSE_URL is required for source schema application");
const client = createClient({
	url,
	username: process.env.CLICKHOUSE_USER ?? "default",
	password: process.env.CLICKHOUSE_PASSWORD ?? "",
});
try {
	await ensureArchiveSchema(client);
} finally {
	await client.close();
}
