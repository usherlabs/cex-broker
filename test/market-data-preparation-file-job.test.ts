import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	assertSafeFileJobPaths,
	assertSupportedNode22,
	atomicWriteJsonResult,
	FileJobUnreadableError,
	parseFileJobArgv,
	readBoundedRegularFile,
	redactDiagnostics,
	sha256RegularFile,
} from "../src/helpers/market-data-preparation/file-job";

async function createAttempt(): Promise<{
	root: string;
	requestPath: string;
	resultPath: string;
}> {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "cex-preparation-file-job-"),
	);
	const requestPath = path.join(root, "request.json");
	await writeFile(requestPath, "{}\n");
	return { root, requestPath, resultPath: path.join(root, "result.json") };
}

describe("market-data preparation file-job boundary", () => {
	test("accepts only the exact run argv and requires Node 22+", () => {
		expect(
			parseFileJobArgv([
				"run",
				"--request",
				"/attempt/request.json",
				"--result",
				"/attempt/result.json",
			]),
		).toEqual({
			requestPath: "/attempt/request.json",
			resultPath: "/attempt/result.json",
		});
		for (const argv of [
			[],
			["run", "--request", "request.json"],
			["run", "--result", "result.json", "--request", "request.json"],
			[
				"run",
				"--request",
				"request.json",
				"--result",
				"result.json",
				"--extra",
			],
		]) {
			expect(() => parseFileJobArgv(argv)).toThrow("expected exactly");
		}
		expect(() => assertSupportedNode22("20.19.0", "test-product")).toThrow(
			"requires Node 22 or newer",
		);
		expect(() => assertSupportedNode22("22.0.0", "test-product")).not.toThrow();
	});

	test("requires one real attempt root and rejects traversal and result symlinks", async () => {
		const attempt = await createAttempt();
		const other = await mkdtemp(
			path.join(os.tmpdir(), "cex-preparation-other-"),
		);
		try {
			expect(
				await assertSafeFileJobPaths(attempt.requestPath, attempt.resultPath),
			).toEqual({
				attemptRoot: attempt.root,
				requestPath: attempt.requestPath,
				resultPath: attempt.resultPath,
			});
			await expect(
				assertSafeFileJobPaths(
					`${attempt.root}/nested/../request.json`,
					attempt.resultPath,
				),
			).rejects.toThrow(FileJobUnreadableError);
			await expect(
				assertSafeFileJobPaths(
					attempt.requestPath,
					path.join(other, "result.json"),
				),
			).rejects.toThrow("result parent");
			await symlink("request.json", attempt.resultPath);
			await expect(
				assertSafeFileJobPaths(attempt.requestPath, attempt.resultPath),
			).rejects.toThrow("result target");
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
			await rm(other, { recursive: true, force: true });
		}
	});

	test("rejects symlinked roots and bounded-input symlinks without following them", async () => {
		const attempt = await createAttempt();
		const parent = await mkdtemp(
			path.join(os.tmpdir(), "cex-preparation-link-"),
		);
		const linkedRoot = path.join(parent, "attempt-link");
		try {
			await symlink(attempt.root, linkedRoot);
			await expect(
				assertSafeFileJobPaths(
					path.join(linkedRoot, "request.json"),
					path.join(linkedRoot, "result.json"),
				),
			).rejects.toThrow("attempt root");

			const linkedInput = path.join(attempt.root, "linked.json");
			await symlink("request.json", linkedInput);
			await expect(readBoundedRegularFile(linkedInput, 1024)).rejects.toThrow(
				FileJobUnreadableError,
			);
			await expect(
				readBoundedRegularFile(attempt.requestPath, 1),
			).rejects.toThrow("bounded");
		} finally {
			await rm(parent, { recursive: true, force: true });
			await rm(attempt.root, { recursive: true, force: true });
		}
	});

	test("self-hashes only a regular no-follow executable", async () => {
		const attempt = await createAttempt();
		try {
			const executablePath = path.join(attempt.root, "executable.js");
			await writeFile(executablePath, "#!/usr/bin/env node\n");
			expect(await sha256RegularFile(executablePath)).toBe(
				createHash("sha256").update("#!/usr/bin/env node\n").digest("hex"),
			);
			const linkedExecutable = path.join(attempt.root, "linked-executable.js");
			await symlink("executable.js", linkedExecutable);
			await expect(sha256RegularFile(linkedExecutable)).rejects.toThrow(
				FileJobUnreadableError,
			);
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
		}
	});

	test("redacts every planted secret from diagnostic keys and string values", () => {
		const redacted = redactDiagnostics(
			{
				"token-secret-key": "request failed: token-secret",
				count: 2,
				enabled: true,
			},
			new Set(["token-secret"]),
		);
		expect(JSON.stringify(redacted)).not.toContain("token-secret");
		expect(redacted).toEqual({
			"[REDACTED]-key": "request failed: [REDACTED]",
			count: 2,
			enabled: true,
		});
	});

	test("writes result bytes atomically and durably, cleaning failed temporary files", async () => {
		const attempt = await createAttempt();
		const result = { ok: true, digest: "a".repeat(64) };
		try {
			const events: string[] = [];
			await atomicWriteJsonResult(attempt.resultPath, result, {
				validate: (value) => expect(value).toEqual(result),
				hooks: {
					beforeTempOpen: () => events.push("open"),
					beforeFileFsync: () => events.push("file-fsync"),
					beforeRename: () => events.push("rename"),
					beforeDirectoryFsync: () => events.push("directory-fsync"),
				},
			});
			expect(await readFile(attempt.resultPath, "utf8")).toBe(
				`${JSON.stringify(result)}\n`,
			);
			expect(events).toEqual([
				"open",
				"file-fsync",
				"rename",
				"directory-fsync",
			]);

			const failedPath = path.join(attempt.root, "failed.json");
			await expect(
				atomicWriteJsonResult(failedPath, result, {
					hooks: {
						beforeRename() {
							throw Object.assign(new Error("rename failed"), { code: "EIO" });
						},
					},
				}),
			).rejects.toThrow("rename failed");
			await expect(lstat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				(await readdir(attempt.root)).filter((name) => name.endsWith(".tmp")),
			).toEqual([]);
		} finally {
			await rm(attempt.root, { recursive: true, force: true });
		}
	});
});
