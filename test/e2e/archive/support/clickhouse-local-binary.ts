import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	rename,
	rm,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";

export const CLICKHOUSE_LOCAL_VERSION = "25.8.24.21";

export type ClickHouseLocalArtifact = {
	url: string;
	sha512: string;
	extractedBinary: string;
	cacheKey: string;
};

export const CLICKHOUSE_LOCAL_ARTIFACT = {
	url: "https://packages.clickhouse.com/tgz/lts/clickhouse-common-static-25.8.24.21-amd64.tgz",
	sha512:
		"a687eff77c58afbe56b7112d9130ee429d0a39a308c2494ff99ef9f8dd4e573b601f6f96be4a32cffb745b6ff9262c653e575b3ca8df5bde12a6238efbe538bd",
	extractedBinary: "clickhouse-common-static-25.8.24.21/usr/bin/clickhouse",
	cacheKey: "clickhouse-local-25.8.24.21-a687eff77c58afbe",
} as const satisfies ClickHouseLocalArtifact;

const REPOSITORY_ROOT = join(import.meta.dir, "../../../..");
const DEFAULT_CACHE_ROOT = join(REPOSITORY_ROOT, ".cache", "clickhouse-local");

function assertSupportedPlatform(): void {
	if (process.platform !== "linux") {
		throw new Error(
			`ClickHouse Local ${CLICKHOUSE_LOCAL_VERSION} is unsupported on ${process.platform}`,
		);
	}
}

async function runCommand(
	command: string[],
	options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	const child = Bun.spawn(command, {
		cwd: options.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(
		() => child.kill("SIGKILL"),
		options.timeoutMs ?? 30_000,
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	clearTimeout(timer);
	if (exitCode !== 0) {
		throw new Error(
			`${command.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
		);
	}
	return { stdout, stderr };
}

export async function verifyClickHouseLocalBinary(
	binaryPath: string,
): Promise<string> {
	try {
		await access(binaryPath, constants.X_OK);
	} catch (error) {
		throw new Error(
			`ClickHouse Local binary is not executable: ${binaryPath}`,
			{
				cause: error,
			},
		);
	}

	let output: string;
	try {
		const result = await runCommand([binaryPath, "local", "--version"], {
			timeoutMs: 10_000,
		});
		output = `${result.stdout}\n${result.stderr}`;
	} catch (error) {
		throw new Error(`Unable to verify ClickHouse Local binary ${binaryPath}`, {
			cause: error,
		});
	}
	const reportedVersion = output.match(/\b(\d+\.\d+\.\d+\.\d+)\b/)?.[1];
	if (reportedVersion !== CLICKHOUSE_LOCAL_VERSION) {
		throw new Error(
			`expected ClickHouse Local ${CLICKHOUSE_LOCAL_VERSION}, received ${reportedVersion ?? "no version"} from ${binaryPath}`,
		);
	}
	return binaryPath;
}

async function sha512(path: string): Promise<string> {
	const hash = createHash("sha512");
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

async function download(url: string, destination: string): Promise<void> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(
			`ClickHouse Local download failed with HTTP ${response.status}: ${url}`,
		);
	}
	await pipeline(
		response.body,
		createWriteStream(destination, { flags: "wx" }),
	);
}

async function installArtifact(
	artifact: ClickHouseLocalArtifact,
	cacheRoot: string,
): Promise<string> {
	await mkdir(cacheRoot, { recursive: true });
	const cacheDirectory = join(cacheRoot, artifact.cacheKey);
	const cachedBinary = join(cacheDirectory, "clickhouse");
	if (await Bun.file(cachedBinary).exists()) {
		return verifyClickHouseLocalBinary(cachedBinary);
	}

	const temporaryRoot = await mkdtemp(join(cacheRoot, ".install-"));
	try {
		const archivePath = join(
			temporaryRoot,
			basename(new URL(artifact.url).pathname),
		);
		const extractedRoot = join(temporaryRoot, "extracted");
		const stagedDirectory = join(temporaryRoot, artifact.cacheKey);
		await mkdir(extractedRoot);
		await mkdir(stagedDirectory);
		await download(artifact.url, archivePath);
		const actualDigest = await sha512(archivePath);
		if (actualDigest !== artifact.sha512) {
			throw new Error(
				`ClickHouse Local archive checksum mismatch: expected ${artifact.sha512}, received ${actualDigest}`,
			);
		}
		await runCommand(["tar", "-xzf", archivePath, "-C", extractedRoot], {
			timeoutMs: 120_000,
		});
		const extractedBinary = join(extractedRoot, artifact.extractedBinary);
		if (!(await Bun.file(extractedBinary).exists())) {
			throw new Error(
				`ClickHouse Local archive did not contain ${artifact.extractedBinary}`,
			);
		}
		await copyFile(extractedBinary, join(stagedDirectory, "clickhouse"));
		await chmod(join(stagedDirectory, "clickhouse"), 0o755);
		await verifyClickHouseLocalBinary(join(stagedDirectory, "clickhouse"));
		try {
			await rename(stagedDirectory, cacheDirectory);
		} catch (error) {
			if (!(await Bun.file(cachedBinary).exists())) {
				throw error;
			}
		}
		return verifyClickHouseLocalBinary(cachedBinary);
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

export async function resolveClickHouseLocalBinary(options?: {
	cacheRoot?: string;
}): Promise<string> {
	const override = process.env.CLICKHOUSE_LOCAL_BIN?.trim();
	if (override) {
		try {
			return await verifyClickHouseLocalBinary(override);
		} catch (error) {
			throw new Error(
				`CLICKHOUSE_LOCAL_BIN failed exact-version verification`,
				{
					cause: error,
				},
			);
		}
	}
	assertSupportedPlatform();
	return installArtifact(
		CLICKHOUSE_LOCAL_ARTIFACT,
		options?.cacheRoot ??
			process.env.CLICKHOUSE_LOCAL_CACHE_DIR?.trim() ??
			DEFAULT_CACHE_ROOT,
	);
}
