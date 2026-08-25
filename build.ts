import dts from "bun-plugin-dts";
import { chmod, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveBuildGitHead } from "./scripts/build-provenance";
import { PREPARATION_CONFORMANCE_FIXTURES } from "./src/helpers/market-data-preparation/conformance-fixtures";

const packageDocument = (await Bun.file("./package.json").json()) as {
	version?: unknown;
};
if (
	typeof packageDocument.version !== "string" ||
	!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(
		packageDocument.version,
	)
) {
	throw new Error("package.json has no pin-eligible version");
}
const gitHead = resolveBuildGitHead({
	environmentGitHead: process.env.CEX_BROKER_BUILD_GIT_HEAD,
	resolveRepositoryGitHead: () => {
		const gitHeadProcess = Bun.spawnSync({
			cmd: ["git", "rev-parse", "HEAD"],
			stdout: "pipe",
			stderr: "pipe",
		});
		return gitHeadProcess.exitCode === 0
			? gitHeadProcess.stdout.toString()
			: "";
	},
});

await Bun.build({
	entrypoints: ["./src/cli.ts"],
	outdir: "./dist/commands",
	target: "node",
	plugins: [dts()],
});

await Bun.build({
	entrypoints: ["./src/index.ts"],
	outdir: "./dist",
	target: "node",
	external: [
		"fs",
		"path",
		"url",
		"util",
		"stream",
		"buffer",
		"os",
		"events",
		"@grpc/grpc-js",
		"@grpc/proto-loader",
		"protobufjs",
		"long",
		"@protobufjs/inquire",
	],
	sourcemap: "external",
	plugins: [
		// dts()
	],
});

await Bun.build({
	entrypoints: ["./src/market-data-vendor-backfill.ts"],
	outdir: "./dist",
	target: "node",
	external: ["zod"],
	sourcemap: "external",
});

await Bun.build({
	entrypoints: ["./src/market-data-preparation.ts"],
	outdir: "./dist",
	target: "node",
	sourcemap: "external",
});

const preparationCommands = [
	"market-data-vendor-backfill",
	"cex-canonical-orderbook-export",
] as const;
const commandBuild = await Bun.build({
	entrypoints: preparationCommands.map((name) => `./src/commands/${name}.ts`),
	outdir: "./dist/commands",
	target: "node",
	format: "esm",
	banner: "#!/usr/bin/env node",
	define: {
		__CEX_BROKER_PACKAGE_VERSION__: JSON.stringify(packageDocument.version),
		__CEX_BROKER_GIT_HEAD__: JSON.stringify(gitHead),
	},
	sourcemap: "external",
});
if (!commandBuild.success) {
	throw new Error(
		`preparation command build failed: ${commandBuild.logs.join("; ")}`,
	);
}
for (const command of preparationCommands) {
	await chmod(`./dist/commands/${command}.js`, 0o755);
}

const preparationAssetOutput = "./dist/market-data-preparation";
await rm("./dist/market-data-vendor-backfill", {
	recursive: true,
	force: true,
});
await rm(preparationAssetOutput, { recursive: true, force: true });
const preparationAssets = [
	["./src/helpers/market-data-preparation/schema-manifest.json", "schema-manifest.json"],
	["./src/helpers/market-data-vendor-backfill/schemas/request.schema.json", "schemas/backfill-request-v1.schema.json"],
	["./src/helpers/market-data-preparation/schemas/backfill-result-v2.schema.json", "schemas/backfill-result-v2.schema.json"],
	["./src/helpers/market-data-vendor-backfill/schemas/required-clock.schema.json", "schemas/required-clock-v1.schema.json"],
	["./src/helpers/market-data-vendor-backfill/schemas/archive-selection.schema.json", "schemas/archive-selection-v1.schema.json"],
	["./src/helpers/market-data-vendor-backfill/schemas/promotion-receipt.schema.json", "schemas/promotion-receipt-v1.schema.json"],
	["./src/helpers/market-data-preparation/schemas/canonical-orderbook-export-request.schema.json", "schemas/canonical-orderbook-export-request-v1.schema.json"],
	["./src/helpers/market-data-preparation/schemas/canonical-orderbook-export-result.schema.json", "schemas/canonical-orderbook-export-result-v2.schema.json"],
	["./src/helpers/market-data-preparation/schemas/preparation-product-pin.schema.json", "schemas/preparation-product-pin-v2.schema.json"],
	["./src/helpers/market-data-preparation/schemas/order-book-levels-parquet-projection.schema.json", "schemas/order-book-levels-parquet-projection-v1.schema.json"],
	["./src/helpers/market-data-preparation/schemas/order-book-depth-summary-parquet-projection.schema.json", "schemas/order-book-depth-summary-parquet-projection-v1.schema.json"],
	["./src/helpers/market-data-preparation/schemas/source-forensics-ledger.schema.json", "schemas/source-forensics-ledger-v1.schema.json"],
	["./src/helpers/market-data-preparation/schemas/source-qualification-record.schema.json", "schemas/source-qualification-record-v1.schema.json"],
	["./src/helpers/market-data-vendor-backfill/policies/capability-policy-v3.json", "policies/capability-policy.json"],
	["./src/helpers/market-data-vendor-backfill/policies/resource-policy-v2.json", "policies/resource-policy.json"],
] as const;
for (const [sourcePath, outputPath] of preparationAssets) {
	const destination = `${preparationAssetOutput}/${outputPath}`;
	await Bun.spawn({ cmd: ["mkdir", "-p", dirname(destination)] }).exited;
	await Bun.write(destination, Bun.file(sourcePath));
}
await Bun.spawn({
	cmd: ["mkdir", "-p", `${preparationAssetOutput}/fixtures`],
}).exited;
await Bun.write(
	`${preparationAssetOutput}/fixtures/conformance-v3.json`,
	`${JSON.stringify(PREPARATION_CONFORMANCE_FIXTURES, null, "\t")}\n`,
);

// Copy descriptor alongside dist output for runtime import
await Bun.spawn({ cmd: ["mkdir", "-p", "./dist/proto"] }).exited;
await Bun.write(
	"./dist/proto/node.descriptor.ts",
	await Bun.file("./src/proto/node.descriptor.ts").text(),
);

// Generates `dist/index.d.ts` and `dist/other/foo.d.ts`

console.log("Build complete.");
