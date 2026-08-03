import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SELF_PATH = "test/e2e/archive/support/archive-configuration-surface.ts";
const SCAN_ROOTS = [
	".github/workflows",
	"docs",
	"e2e",
	"schema",
	"scripts",
	"services",
	"src",
	"test",
] as const;
const ROOT_FILES = [".env.sample", "README.md", "package.json"] as const;
const TEXT_EXTENSIONS = new Set([
	".cjs",
	".js",
	".json",
	".md",
	".mjs",
	".sql",
	".ts",
	".tsx",
	".yaml",
	".yml",
]);
const FORBIDDEN_TOKENS = [
	"CEX_BROKER_MARKET_ARCHIVE_WRITE_MODE",
	"CEX_BROKER_CREDENTIAL_SOURCE_POLICY",
	"CEX_BROKER_PROVISIONED_CREDENTIAL_PROFILE",
	"CEX_BROKER_CREDENTIAL_ATTESTATION_KIND",
	"CEX_BROKER_CREDENTIAL_ATTESTATION_REFERENCE",
	"CEX_BROKER_SMOKE_READ_ONLY_ATTESTED",
	"CEX_BROKER_SMOKE_API_KEY",
	"CEX_BROKER_SMOKE_API_SECRET",
	"getMarketArchiveWriteMode",
	"CredentialPolicy",
	"credentialPolicy",
	"provisionedProfile",
	"sourcePolicy",
	"provisioned_only",
	"read_only_key",
	"writeMode",
] as const;
const SMOKE_FILES = new Set([
	".github/workflows/archive-live-smoke.yml",
	"scripts/archive-live-smoke.ts",
]);
const FORBIDDEN_SMOKE_TOKENS = [
	"ARCHIVE_SMOKE_API_KEY",
	"ARCHIVE_SMOKE_API_SECRET",
	"ARCHIVE_SMOKE_READ_ONLY_ATTESTATION",
	"apiKey",
	"apiSecret",
] as const;

async function collectFiles(path: string): Promise<string[]> {
	const entries = await readdir(join(REPOSITORY_ROOT, path), {
		withFileTypes: true,
	});
	const files: string[] = [];
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) files.push(...(await collectFiles(child)));
		else if (TEXT_EXTENSIONS.has(extname(entry.name))) files.push(child);
	}
	return files;
}

function isAllowedNegativeAssertion(
	path: string,
	line: string,
	token: string,
): boolean {
	return (
		path === "test/canonical-market-data-migration.test.ts" &&
		line.includes(`not.toContain("${token}")`)
	);
}

export async function auditArchiveConfigurationSurface(): Promise<string[]> {
	const nestedFiles = await Promise.all(SCAN_ROOTS.map(collectFiles));
	const files = [...ROOT_FILES, ...nestedFiles.flat()].filter(
		(path) => path !== SELF_PATH,
	);
	const violations: string[] = [];

	for (const path of files) {
		const contents = await readFile(join(REPOSITORY_ROOT, path), "utf8");
		for (const [index, line] of contents.split("\n").entries()) {
			for (const token of FORBIDDEN_TOKENS) {
				if (
					!line.includes(token) ||
					isAllowedNegativeAssertion(path, line, token)
				)
					continue;
				violations.push(
					`${relative(REPOSITORY_ROOT, join(REPOSITORY_ROOT, path))}:${index + 1}: ${token}`,
				);
			}
			if (SMOKE_FILES.has(path)) {
				for (const token of FORBIDDEN_SMOKE_TOKENS) {
					if (line.includes(token))
						violations.push(`${path}:${index + 1}: ${token}`);
				}
			}
		}
	}

	return violations.sort();
}
