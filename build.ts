import dts from "bun-plugin-dts";

await Bun.build({
	entrypoints: ["./src/cli.ts"],
	outdir: "./dist/commands",
	target: "node",
	plugins: [dts()],
});

await Bun.build({
	entrypoints: ["./src/index.ts"],
	outdir: "./dist",
	target: "bun",
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

// Copy descriptor alongside dist output for runtime import
await Bun.spawn({ cmd: ["mkdir", "-p", "./dist/proto"] }).exited;
await Bun.write(
    './dist/proto/node.descriptor.ts',
    await Bun.file('./src/proto/node.descriptor.ts').text(),
);

// Generates `dist/index.d.ts` and `dist/other/foo.d.ts`

console.log("Build complete.");
