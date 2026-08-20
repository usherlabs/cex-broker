import dts from "bun-plugin-dts";
import { dirname } from "node:path";

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

const backfillAssetRoot = "./src/helpers/market-data-vendor-backfill";
const backfillAssetOutput = "./dist/market-data-vendor-backfill";
const backfillAssets = [
	["schemas/schema-manifest.json", "schema-manifest.json"],
	["schemas/request.schema.json", "schemas/request.schema.json"],
	["schemas/result.schema.json", "schemas/result.schema.json"],
	["schemas/required-clock.schema.json", "schemas/required-clock.schema.json"],
	["schemas/archive-selection.schema.json", "schemas/archive-selection.schema.json"],
	["schemas/promotion-receipt.schema.json", "schemas/promotion-receipt.schema.json"],
	["policies/capability-policy.json", "policies/capability-policy.json"],
	["policies/resource-policy.json", "policies/resource-policy.json"],
	["fixtures/conformance-v1.json", "fixtures/conformance-v1.json"],
] as const;

for (const [sourcePath, outputPath] of backfillAssets) {
	const destination = `${backfillAssetOutput}/${outputPath}`;
	await Bun.spawn({ cmd: ["mkdir", "-p", dirname(destination)] }).exited;
	await Bun.write(destination, Bun.file(`${backfillAssetRoot}/${sourcePath}`));
}

// Copy descriptor alongside dist output for runtime import
await Bun.spawn({ cmd: ["mkdir", "-p", "./dist/proto"] }).exited;
await Bun.write(
	"./dist/proto/node.descriptor.ts",
	await Bun.file("./src/proto/node.descriptor.ts").text(),
);

// Generates `dist/index.d.ts` and `dist/other/foo.d.ts`

console.log("Build complete.");
