import { expect, test } from "bun:test";
import path from "node:path";

async function waitForFile(filePath: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (await Bun.file(filePath).exists()) {
			return;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForFetchCount(
	filePath: string,
	minimum: number,
): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (await Bun.file(filePath).exists()) {
			const count = Number(await Bun.file(filePath).text());
			if (count >= minimum) {
				return count;
			}
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${minimum} fetches in ${filePath}`);
}

async function runShutdownCase(exchangeCloseHangs: boolean): Promise<{
	exitCode: number;
	closeMarker: string;
	countBeforeShutdown: number;
	countAtShutdown: number;
	output: string;
}> {
	const fixtureId = crypto.randomUUID();
	const configPath = `/tmp/ohlcv-shutdown-${fixtureId}.json`;
	const activePath = `/tmp/ohlcv-shutdown-${fixtureId}.active`;
	const countPath = `/tmp/ohlcv-shutdown-${fixtureId}.count`;
	const closedPath = `/tmp/ohlcv-shutdown-${fixtureId}.closed`;
	await Bun.write(
		configPath,
		JSON.stringify([{ exchange: "binance", symbol: "BTC/USDT" }]),
	);

	const child = Bun.spawn({
		cmd: [
			process.execPath,
			"--preload",
			path.resolve("test/fixtures/ohlcv-collector-fake-exchange.ts"),
			path.resolve("services/ohlcv-collector/index.ts"),
		],
		cwd: process.cwd(),
		env: {
			...process.env,
			CEX_BROKER_OHLCV_COLLECTOR_CONFIG: configPath,
			CEX_BROKER_OHLCV_ARCHIVE_BOOTSTRAP_LIMIT: "0",
			OHLCV_TEST_EXCHANGE_ACTIVE_PATH: activePath,
			OHLCV_TEST_EXCHANGE_COUNT_PATH: countPath,
			OHLCV_TEST_EXCHANGE_CLOSED_PATH: closedPath,
			OHLCV_TEST_EXCHANGE_CLOSE_HANG: String(exchangeCloseHangs),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();

	try {
		await waitForFile(activePath);
		const countBeforeShutdown = await waitForFetchCount(countPath, 5);
		expect(await Bun.file(closedPath).exists()).toBe(false);
		await Bun.sleep(100);
		const countAtShutdown = await waitForFetchCount(
			countPath,
			countBeforeShutdown + 1,
		);
		expect(await Bun.file(closedPath).exists()).toBe(false);
		child.kill("SIGTERM");
		const result = await Promise.race([
			child.exited.then((exitCode) => ({ exitCode })),
			Bun.sleep(5_000).then(() => null),
		]);
		if (!result) {
			child.kill("SIGKILL");
			await child.exited;
			throw new Error(
				`Collector did not exit within 5s\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
			);
		}
		return {
			exitCode: result.exitCode,
			closeMarker: await Bun.file(closedPath).text(),
			countBeforeShutdown,
			countAtShutdown,
			output: `${await stdout}\n${await stderr}`,
		};
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		await Promise.all(
			[configPath, activePath, countPath, closedPath].map(async (filePath) => {
				if (await Bun.file(filePath).exists()) {
					await Bun.file(filePath).delete();
				}
			}),
		);
	}
}

test("entrypoint exits promptly on SIGTERM after an exchange stream opens", async () => {
	const result = await runShutdownCase(false);
	expect(result.exitCode).toBe(0);
	expect(result.closeMarker).toBe("closed");
	expect(result.countAtShutdown).toBeGreaterThan(result.countBeforeShutdown);
});

test("entrypoint bounds shutdown when an exchange close does not resolve", async () => {
	const result = await runShutdownCase(true);
	expect(result.exitCode).toBe(0);
	expect(result.closeMarker).toBe("close_attempted");
	expect(result.output).toContain("OHLCV collector shutdown path timed out");
	expect(result.output).toContain("subscribe_brokers");
});
