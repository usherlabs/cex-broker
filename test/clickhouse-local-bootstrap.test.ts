import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLICKHOUSE_LOCAL_ARTIFACT,
	CLICKHOUSE_LOCAL_VERSION,
	resolveClickHouseLocalBinary,
	verifyClickHouseLocalBinary,
} from "./e2e/archive/support/clickhouse-local-binary";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	delete process.env.CLICKHOUSE_LOCAL_BIN;
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fakeBinary(version: string): Promise<string> {
	const directory = await mkdtemp(
		join(tmpdir(), "archive-e2e-clickhouse-bin-"),
	);
	temporaryDirectories.push(directory);
	const path = join(directory, "clickhouse");
	await Bun.write(
		path,
		`#!/bin/sh\nprintf '%s\\n' 'ClickHouse local version ${version} (official build).'\n`,
	);
	await chmod(path, 0o755);
	return path;
}

describe("ClickHouse Local pinned binary", () => {
	test("commits the exact official artifact", () => {
		expect(CLICKHOUSE_LOCAL_VERSION).toBe("25.8.24.21");
		expect(CLICKHOUSE_LOCAL_ARTIFACT).toEqual({
			url: "https://packages.clickhouse.com/tgz/lts/clickhouse-common-static-25.8.24.21-amd64.tgz",
			sha512:
				"a687eff77c58afbe56b7112d9130ee429d0a39a308c2494ff99ef9f8dd4e573b601f6f96be4a32cffb745b6ff9262c653e575b3ca8df5bde12a6238efbe538bd",
			extractedBinary: "clickhouse-common-static-25.8.24.21/usr/bin/clickhouse",
			cacheKey: "clickhouse-local-25.8.24.21-a687eff77c58afbe",
		});
	});

	test("accepts only an executable reporting the exact pinned version", async () => {
		const exact = await fakeBinary(CLICKHOUSE_LOCAL_VERSION);
		await expect(verifyClickHouseLocalBinary(exact)).resolves.toBe(exact);

		const wrong = await fakeBinary("25.8.25.37");
		await expect(verifyClickHouseLocalBinary(wrong)).rejects.toThrow(
			"expected ClickHouse Local 25.8.24.21",
		);
	});

	test("validates CLICKHOUSE_LOCAL_BIN instead of silently trusting it", async () => {
		const wrong = await fakeBinary("25.8.25.37");
		process.env.CLICKHOUSE_LOCAL_BIN = wrong;
		await expect(resolveClickHouseLocalBinary()).rejects.toThrow(
			"CLICKHOUSE_LOCAL_BIN",
		);

		const exact = await fakeBinary(CLICKHOUSE_LOCAL_VERSION);
		process.env.CLICKHOUSE_LOCAL_BIN = exact;
		await expect(resolveClickHouseLocalBinary()).resolves.toBe(exact);
	});
});
