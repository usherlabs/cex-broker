import { writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import protobuf from "protobufjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
	const rootDir = resolve(__dirname, "..");
	const protoPath = resolve(rootDir, "src/proto/node.proto");
	const outPath = resolve(rootDir, "src/proto/node.descriptor.ts");

	const root = await protobuf.load(protoPath);
	const json = root.toJSON();

	const header = `// Auto-generated from src/proto/node.proto. Do not edit manually.\n`;
	const body = `const descriptor = ${JSON.stringify(json, null, 2)} as const;\n\nexport default descriptor;\n`;

	await writeFile(outPath, header + body, "utf8");
	console.log(`✓ Wrote descriptor to ${outPath}`);
}

main().catch((err) => {
	console.error("Failed to generate descriptor:", err);
	process.exit(1);
});
