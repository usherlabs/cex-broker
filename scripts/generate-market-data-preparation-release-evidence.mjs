import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function argumentsByName(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || !value) {
			throw new Error("every release-evidence option requires one value");
		}
		values.set(name.slice(2), value);
	}
	return values;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function sha512Integrity(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function required(options, name) {
	const value = options.get(name);
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

const options = argumentsByName(process.argv.slice(2));
const tarballPath = path.resolve(required(options, "tarball"));
const evidencePath = path.resolve(required(options, "out"));
const registryNames = [
	"registry-url",
	"registry-integrity",
	"npm-git-head",
	"pin-out",
];
const registryValues = registryNames.map((name) => options.get(name));
if (
	registryValues.some(Boolean) &&
	!registryValues.every((value) => typeof value === "string")
) {
	throw new Error(
		"post-registry product-pin generation requires --registry-url, --registry-integrity, --npm-git-head, and --pin-out together",
	);
}
const registryComplete = registryValues.every(
	(value) => typeof value === "string",
);
const tarballBytes = readFileSync(tarballPath);
const tarballSha256 = sha256(tarballBytes);
let registryPackageVersion;
if (registryComplete) {
	const registryUrl = options.get("registry-url");
	const integrity = options.get("registry-integrity");
	const npmGitHead = options.get("npm-git-head");
	const registryUrlMatch =
		/^https:\/\/registry\.npmjs\.org\/@usherlabs\/cex-broker\/-\/cex-broker-([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(
			registryUrl,
		);
	if (
		!registryUrlMatch ||
		!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) ||
		!/^[0-9a-f]{40}$/.test(npmGitHead)
	) {
		throw new Error("registry product identity is malformed");
	}
	registryPackageVersion = registryUrlMatch[1];
	if (integrity !== sha512Integrity(tarballBytes)) {
		throw new Error("registry integrity does not match the supplied tarball");
	}
}

const temporaryRoot = mkdtempSync(
	path.join(os.tmpdir(), "cex-preparation-release-evidence-"),
);
try {
	execFileSync("tar", ["-xzf", tarballPath, "-C", temporaryRoot]);
	const extracted = path.join(temporaryRoot, "package");
	const packageDocument = JSON.parse(
		readFileSync(path.join(extracted, "package.json"), "utf8"),
	);
	if (
		packageDocument.name !== "@usherlabs/cex-broker" ||
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageDocument.version)
	) {
		throw new Error("tarball is not a versioned @usherlabs/cex-broker package");
	}
	if (registryComplete && registryPackageVersion !== packageDocument.version) {
		throw new Error("registry URL version does not match the supplied tarball");
	}
	const manifest = JSON.parse(
		readFileSync(
			path.join(extracted, "dist/market-data-preparation/schema-manifest.json"),
			"utf8",
		),
	);
	const capabilityPolicy = JSON.parse(
		readFileSync(
			path.join(
				extracted,
				"dist/market-data-preparation/policies/capability-policy.json",
			),
			"utf8",
		),
	);
	const resourcePolicy = JSON.parse(
		readFileSync(
			path.join(
				extracted,
				"dist/market-data-preparation/policies/resource-policy.json",
			),
			"utf8",
		),
	);
	const executablePins = [
		{
			product_id: "market-data-vendor-backfill",
			product_version: "market-data-vendor-backfill/v1",
			relative_path: "dist/commands/market-data-vendor-backfill.js",
		},
		{
			product_id: "cex-canonical-orderbook-export",
			product_version: "cex-canonical-orderbook-export/v1",
			relative_path: "dist/commands/cex-canonical-orderbook-export.js",
		},
	].map((pin) => ({
		...pin,
		executable_sha256: sha256(
			readFileSync(path.join(extracted, pin.relative_path)),
		),
	}));
	const evidence = {
		schema_id: "cex-market-data-preparation-release-evidence/v1",
		status: registryComplete
			? "registry_tarball_verified"
			: "candidate_unpublished",
		package: {
			name: packageDocument.name,
			version: packageDocument.version,
			candidate_tarball_sha256: tarballSha256,
		},
		executables: executablePins,
		schema_manifest: {
			schema_id: manifest.schema_id,
			manifest_sha256: manifest.manifest_sha256,
		},
		registry: registryComplete
			? {
					tarball_url: options.get("registry-url"),
					integrity: options.get("registry-integrity"),
					npm_git_head: options.get("npm-git-head"),
					tarball_sha256: tarballSha256,
				}
			: null,
		pending_steps: registryComplete
			? []
			: [
					"merge the clean release commit",
					`tag v${packageDocument.version}`,
					`publish @usherlabs/cex-broker@${packageDocument.version}`,
					"download the registry tarball and verify npm metadata",
					"run the protected provider smoke with the extracted package",
					"generate the post-registry product pin",
				],
	};
	writeFileSync(evidencePath, `${JSON.stringify(evidence, null, "\t")}\n`, {
		flag: "wx",
		mode: 0o600,
	});

	if (registryComplete) {
		const registryUrl = options.get("registry-url");
		const integrity = options.get("registry-integrity");
		const npmGitHead = options.get("npm-git-head");
		const productPin = {
			schema_id: "cex-market-data-preparation-product-pin/v1",
			package: {
				name: "@usherlabs/cex-broker",
				version: packageDocument.version,
				registry_tarball_url: registryUrl,
				integrity,
				tarball_sha256: tarballSha256,
				npm_git_head: npmGitHead,
			},
			executables: executablePins,
			schema_manifest: {
				schema_id: manifest.schema_id,
				manifest_sha256: manifest.manifest_sha256,
				relative_path: "dist/market-data-preparation/schema-manifest.json",
			},
			schema_pins: manifest.artifacts.map(({ schema_id, schema_sha256 }) => ({
				schema_id,
				schema_sha256,
			})),
			capability_policy: {
				policy_id: capabilityPolicy.policy_id,
				policy_sha256: capabilityPolicy.policy_sha256,
			},
			resource_policy: {
				policy_id: resourcePolicy.policy_id,
				policy_sha256: resourcePolicy.policy_sha256,
			},
		};
		writeFileSync(
			path.resolve(options.get("pin-out")),
			`${JSON.stringify(productPin, null, "\t")}\n`,
			{ flag: "wx", mode: 0o600 },
		);
	}
	console.log(
		JSON.stringify({ status: evidence.status, evidence: evidencePath }),
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
