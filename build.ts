import dts from "bun-plugin-dts";
import { resolveBuildGitHead } from "./scripts/build-provenance";

// Resolve the release commit even though the final broker-only package no longer
// builds preparation executables. This keeps Docker/npm provenance fail-closed.
resolveBuildGitHead({
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
});

await Bun.spawn({ cmd: ["mkdir", "-p", "./dist/proto"] }).exited;
await Bun.write(
	"./dist/proto/node.descriptor.ts",
	await Bun.file("./src/proto/node.descriptor.ts").text(),
);

console.log("Build complete.");
