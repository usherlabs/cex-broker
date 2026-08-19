#!/usr/bin/env bun
import { resolve } from "node:path";
import { runAndWriteCexOrderBookCoalescingProofA } from "../test/e2e/archive/support/orderbook-equivalence";

const [outputPath, ...extra] = process.argv.slice(2);
if (!outputPath || extra.length > 0) {
	console.error(
		"Usage: bun run archive:proof-a -- <cex-orderbook-coalescing-evidence.json>",
	);
	process.exit(2);
}

try {
	const artifact = await runAndWriteCexOrderBookCoalescingProofA(
		resolve(outputPath),
	);
	console.info(JSON.stringify(artifact));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
