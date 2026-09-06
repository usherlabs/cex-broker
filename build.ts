import { generateDtsBundle } from "dts-bundle-generator";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveBuildGitHead } from "./scripts/build-provenance";
import {
	contractSourceHashes,
	EVIDENCE_SCHEMA_IDS,
	sha256,
} from "./scripts/package-contract";

const gitHead = resolveBuildGitHead({
	environmentGitHead: process.env.CEX_BROKER_BUILD_GIT_HEAD,
	resolveRepositoryGitHead: () => {
		const process = Bun.spawnSync({
			cmd: ["git", "rev-parse", "HEAD"],
			stdout: "pipe",
			stderr: "pipe",
		});
		return process.exitCode === 0 ? process.stdout.toString() : "";
	},
});

await rm("dist", { recursive: true, force: true });
const external = ["@grpc/grpc-js", "@grpc/proto-loader", "protobufjs"];
for (const config of [
	{ entrypoints: ["./src/cli.ts"], outdir: "./dist/commands" },
	{ entrypoints: ["./src/index.ts"], outdir: "./dist" },
	{
		entrypoints: ["./src/proto/node.descriptor.ts"],
		outdir: "./dist/proto",
	},
]) {
	const result = await Bun.build({
		...config,
		target: "node",
		external,
		sourcemap: "external",
	});
	if (!result.success) throw new AggregateError(result.logs, "Package build failed");
}

const declarationEntries = [
	"src/index.ts",
	"src/server.ts",
	"src/types.ts",
	"src/helpers/constants.ts",
	"src/schemas/action-payloads.ts",
	"src/schemas/action-evidence.ts",
	"src/cli.ts",
	...Array.from(new Bun.Glob("src/proto/**/*.ts").scanSync()).sort(),
];
const declarations = generateDtsBundle(
	declarationEntries.map((filePath) => ({
		filePath: resolve(filePath),
		output: { exportReferencedTypes: false },
	})),
	{ preferredConfigPath: "tsconfig.json" },
);
for (const [index, entry] of declarationEntries.entries()) {
	const destination =
		entry === "src/cli.ts"
			? "dist/commands/cli.d.ts"
			: entry.replace(/^src\//, "dist/").replace(/\.ts$/, ".d.ts");
	const declaration = declarations[index];
	if (!declaration?.trim()) throw new Error(`Missing declaration for ${entry}`);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, declaration);
}
for (const name of ["node.proto", "node.descriptor.ts"]) {
	await writeFile(join("dist/proto", name), await readFile(join("src/proto", name)));
}
const manifest = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
	"dist/build-metadata.json",
	`${JSON.stringify({
		version: manifest.version,
		gitHead,
		protoSha256: sha256(await readFile("src/proto/node.proto")),
		evidenceSchemas: EVIDENCE_SCHEMA_IDS,
		sourceSha256: contractSourceHashes(process.cwd()),
	}, null, 2)}\n`,
);
console.log("Build complete.");
