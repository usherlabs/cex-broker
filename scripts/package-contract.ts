import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TASK_5_GIT_HEAD = "7387e9c2881a27db8787b446146e14f494c1ee0d";
// The GitHub promotion contains the same contract source and is in CI history.
export const TASK_5_GITHUB_HEAD = "34ce9cc6612a93d6095a51dd12b7ed43e7ef35a0";
export const TASK_5_PROTO_SHA256 =
	"7dea012e0fb26e9f742219ace6d102d4eb126d4770ed2a8ca7cee6a41a40eff7";
export const EVIDENCE_SCHEMA_IDS = [
	"cex-trading-fee-evidence/v1",
	"cex-market-rule-evidence/v1",
	"cex-transfer-network-evidence/v1",
	"cex-broker-action-batch/v1",
];
export const CONTRACT_SOURCE_PATHS = [
	"src/proto/node.proto",
	"src/proto/node.descriptor.ts",
	"src/helpers/constants.ts",
	"src/helpers/venue-evidence.ts",
	"src/helpers/broker-execution-archive/redact.ts",
	"src/helpers/grpc/status.ts",
	"src/schemas/action-evidence.ts",
	"src/schemas/action-payloads.ts",
	"src/handlers/execute-action/batch.ts",
	"src/handlers/execute-action/context.ts",
	"src/handlers/execute-action/handler.ts",
	"src/handlers/execute-action/index.ts",
	"src/handlers/execute-action/registry.ts",
	"src/handlers/execute-action/venue-evidence.ts",
	"src/handlers/execute-action/pass-through.ts",
];
export const REQUIRED_PACKAGE_PATHS = [
	"dist/index.js",
	"dist/index.d.ts",
	"dist/commands/cli.js",
	"dist/commands/cli.d.ts",
	"dist/helpers/constants.d.ts",
	"dist/server.d.ts",
	"dist/types.d.ts",
	"dist/schemas/action-payloads.d.ts",
	"dist/schemas/action-evidence.d.ts",
	"dist/proto/node.proto",
	"dist/proto/node.descriptor.ts",
	"dist/proto/node.descriptor.js",
	"dist/proto/node.descriptor.d.ts",
	"dist/proto/node.d.ts",
	"dist/proto/cex_broker/Action.d.ts",
	"dist/proto/cex_broker/ActionRequest.d.ts",
	"dist/proto/cex_broker/ActionResponse.d.ts",
	"dist/build-metadata.json",
];

export function sha256(contents: string | Buffer): string {
	return createHash("sha256").update(contents).digest("hex");
}

export function contractSourceHashes(root: string): Record<string, string> {
	return Object.fromEntries(
		CONTRACT_SOURCE_PATHS.map((path) => [
			path,
			sha256(readFileSync(join(root, path))),
		]),
	);
}
