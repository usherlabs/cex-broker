import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const FILE_JOB_REQUEST_MAX_BYTES = 1_048_576;
export const FILE_JOB_CLOCK_MAX_BYTES = 16_777_216;
export const FILE_JOB_EXECUTABLE_MAX_BYTES = 536_870_912;

export type FileJobPaths = {
	attemptRoot: string;
	requestPath: string;
	resultPath: string;
};

export type AtomicWriteHooks = {
	beforeTempOpen?(tempPath: string): void | Promise<void>;
	beforeFileFsync?(): void | Promise<void>;
	beforeRename?(): void | Promise<void>;
	beforeDirectoryFsync?(): void | Promise<void>;
};

export type AtomicWriteJsonOptions<T> = {
	validate?: (value: T) => void;
	hooks?: AtomicWriteHooks;
};

export type DurableArtifactHooks = {
	beforeOpen?(filePath: string): void | Promise<void>;
	beforeFileFsync?(): void | Promise<void>;
};

export class FileJobUnreadableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FileJobUnreadableError";
	}
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

export function containsParentTraversal(input: string): boolean {
	return input.split(/[\\/]+/u).includes("..");
}

export function assertSupportedNode22(
	version = process.versions.node,
	productName = "market-data preparation executable",
): void {
	const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
	if (!Number.isInteger(major) || major < 22) {
		throw new Error(`${productName} requires Node 22 or newer; got ${version}`);
	}
}

export function parseFileJobArgv(argv: readonly string[]): {
	requestPath: string;
	resultPath: string;
} {
	if (
		argv.length !== 5 ||
		argv[0] !== "run" ||
		argv[1] !== "--request" ||
		argv[3] !== "--result" ||
		!argv[2] ||
		!argv[4]
	) {
		throw new Error("expected exactly: run --request <path> --result <path>");
	}
	return { requestPath: argv[2], resultPath: argv[4] };
}

async function assertAttemptRoot(attemptRoot: string): Promise<void> {
	const stats = await lstat(attemptRoot);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error("attempt root must be a non-symlink directory");
	}
}

async function assertSafeResultTarget(resultPath: string): Promise<void> {
	let stats: Stats;
	try {
		stats = await lstat(resultPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(
			"result target must be absent or a non-symlink regular file",
		);
	}

	const handle = await open(
		resultPath,
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
	);
	try {
		if (!(await handle.stat()).isFile()) {
			throw new Error("opened result target is not a regular file");
		}
	} finally {
		await handle.close();
	}
}

export async function assertSafeFileJobPaths(
	requestInput: string,
	resultInput: string,
): Promise<FileJobPaths> {
	if (
		containsParentTraversal(requestInput) ||
		containsParentTraversal(resultInput)
	) {
		throw new FileJobUnreadableError("parent traversal is not allowed");
	}
	const requestPath = path.resolve(requestInput);
	const resultPath = path.resolve(resultInput);
	const attemptRoot = path.dirname(requestPath);
	if (path.dirname(resultPath) !== attemptRoot) {
		throw new Error("result parent must be identical to the request parent");
	}
	await assertAttemptRoot(attemptRoot);
	await assertSafeResultTarget(resultPath);
	return { attemptRoot, requestPath, resultPath };
}

export function assertSidecarBasename(fileName: string): void {
	if (
		path.basename(fileName) !== fileName ||
		containsParentTraversal(fileName) ||
		fileName.includes("/") ||
		fileName.includes("\\")
	) {
		throw new Error("sidecar file name must be a basename");
	}
}

export async function readBoundedRegularFile(
	filePath: string,
	maximumBytes: number,
): Promise<Buffer> {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
		throw new Error("maximumBytes must be a non-negative safe integer");
	}
	let pathStats: Stats;
	try {
		pathStats = await lstat(filePath);
	} catch (error) {
		throw new FileJobUnreadableError(
			`cannot lstat input: ${errorCode(error) ?? "unknown"}`,
		);
	}
	if (
		pathStats.isSymbolicLink() ||
		!pathStats.isFile() ||
		pathStats.size > maximumBytes
	) {
		throw new FileJobUnreadableError(
			"input must be a bounded non-symlink regular file",
		);
	}

	let handle: FileHandle;
	try {
		handle = await open(
			filePath,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
		);
	} catch (error) {
		throw new FileJobUnreadableError(
			`cannot open input: ${errorCode(error) ?? "unknown"}`,
		);
	}

	let result: Buffer | undefined;
	let readError: FileJobUnreadableError | undefined;
	try {
		const openedStats = await handle.stat();
		if (!openedStats.isFile() || openedStats.size > maximumBytes) {
			throw new FileJobUnreadableError(
				"opened input must be a bounded regular file",
			);
		}
		const bytes = Buffer.alloc(openedStats.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const finalStats = await handle.stat();
		if (
			offset !== bytes.length ||
			finalStats.size !== openedStats.size ||
			finalStats.size > maximumBytes
		) {
			throw new FileJobUnreadableError("input changed while it was being read");
		}
		result = bytes;
	} catch (error) {
		readError =
			error instanceof FileJobUnreadableError
				? error
				: new FileJobUnreadableError(
						`cannot read input: ${errorCode(error) ?? "unknown"}`,
					);
	}
	try {
		await handle.close();
	} catch (error) {
		if (!readError) {
			readError = new FileJobUnreadableError(
				`cannot close input: ${errorCode(error) ?? "unknown"}`,
			);
		}
	}
	if (readError) throw readError;
	if (!result) {
		throw new FileJobUnreadableError("input read produced no result");
	}
	return result;
}

export async function sha256RegularFile(filePath: string): Promise<string> {
	const bytes = await readBoundedRegularFile(
		filePath,
		FILE_JOB_EXECUTABLE_MAX_BYTES,
	);
	return createHash("sha256").update(bytes).digest("hex");
}

export async function writeExclusiveDurableFile(
	filePath: string,
	bytes: Uint8Array,
	hooks: DurableArtifactHooks = {},
): Promise<void> {
	await hooks.beforeOpen?.(filePath);
	const handle = await open(
		filePath,
		fsConstants.O_WRONLY |
			fsConstants.O_CREAT |
			fsConstants.O_EXCL |
			fsConstants.O_NOFOLLOW,
		0o600,
	);
	try {
		if (!(await handle.stat()).isFile()) {
			throw new Error("artifact target is not a regular file");
		}
		await handle.writeFile(bytes);
		await hooks.beforeFileFsync?.();
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function redactString(
	value: string,
	sensitiveValues: ReadonlySet<string>,
): string {
	let redacted = value;
	for (const secret of sensitiveValues) {
		if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
	}
	return redacted;
}

export function redactDiagnostics(
	diagnostics: Readonly<Record<string, string | number | boolean>>,
	sensitiveValues: ReadonlySet<string>,
): Record<string, string | number | boolean> {
	return Object.fromEntries(
		Object.entries(diagnostics).map(([key, value]) => [
			redactString(key, sensitiveValues),
			typeof value === "string" ? redactString(value, sensitiveValues) : value,
		]),
	);
}

async function closeIgnoringErrors(handle: FileHandle | null): Promise<void> {
	if (!handle) return;
	try {
		await handle.close();
	} catch {
		// Preserve the original durable-write failure.
	}
}

export async function atomicWriteJsonResult<T>(
	resultPath: string,
	result: T,
	options: AtomicWriteJsonOptions<T> = {},
): Promise<void> {
	options.validate?.(result);
	const serialized = `${JSON.stringify(result)}\n`;
	const attemptRoot = path.dirname(resultPath);
	const tempPath = path.join(
		attemptRoot,
		`.${path.basename(resultPath)}.${randomUUID()}.tmp`,
	);
	let tempHandle: FileHandle | null = null;
	let renamed = false;

	try {
		try {
			await lstat(tempPath);
			throw new Error("exclusive temporary result path already exists");
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}

		await options.hooks?.beforeTempOpen?.(tempPath);
		tempHandle = await open(
			tempPath,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW,
			0o600,
		);
		if (!(await tempHandle.stat()).isFile()) {
			throw new Error("temporary result is not a regular file");
		}
		await tempHandle.writeFile(serialized, "utf8");
		await options.hooks?.beforeFileFsync?.();
		await tempHandle.sync();
		await tempHandle.close();
		tempHandle = null;

		await options.hooks?.beforeRename?.();
		await rename(tempPath, resultPath);
		renamed = true;

		const directoryHandle = await open(
			attemptRoot,
			fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
		);
		try {
			if (!(await directoryHandle.stat()).isDirectory()) {
				throw new Error("opened attempt root is not a directory");
			}
			try {
				await options.hooks?.beforeDirectoryFsync?.();
				await directoryHandle.sync();
			} catch (error) {
				if (!["ENOTSUP", "EINVAL"].includes(errorCode(error) ?? "")) {
					throw error;
				}
			}
		} finally {
			await directoryHandle.close();
		}
	} catch (error) {
		await closeIgnoringErrors(tempHandle);
		if (!renamed) {
			try {
				await unlink(tempPath);
			} catch (cleanupError) {
				if (errorCode(cleanupError) !== "ENOENT") {
					// The original failure remains authoritative.
				}
			}
		}
		throw error;
	}
}
