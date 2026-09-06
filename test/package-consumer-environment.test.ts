import { expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageConsumerEnvironment } from "../scripts/package-consumer-environment.mjs";

test("package consumer environment removes operator settings without mutating its input", () => {
	const environment = {
		PATH: "/fixture/bin",
		CEX_BROKER_ARCHIVE_ENABLED: "true",
		CEX_BROKER_FIXTURE_API_KEY: "not-a-credential",
		OTEL_EXPORTER_OTLP_HEADERS: "fixture-header",
		OTEL_SERVICE_NAME: "fixture-service",
	};
	expect(packageConsumerEnvironment(environment)).toEqual({
		PATH: "/fixture/bin",
	});
	expect(environment.CEX_BROKER_ARCHIVE_ENABLED).toBe("true");
});

for (const archiveEnabled of [false, true]) {
	test(`isolated broker construction does not touch inherited journal/export or telemetry settings (archive ${archiveEnabled})`, async () => {
		const directory = mkdtempSync(
			join(tmpdir(), "package-consumer-environment-"),
		);
		const journal = join(directory, "journal.jsonl");
		const exported = join(directory, "exported.jsonl");
		// Disabled archiving still exports an existing configured journal; enabled
		// archiving would create a missing journal for append during construction.
		if (!archiveEnabled) writeFileSync(journal, "fixture-journal\n");
		let connections = 0;
		const endpoint = createServer((_request, response) => response.end());
		endpoint.on("connection", () => {
			connections++;
		});
		try {
			await new Promise<void>((resolve) =>
				endpoint.listen(0, "127.0.0.1", resolve),
			);
			const address = endpoint.address();
			if (!address || typeof address === "string")
				throw new Error("Missing fixture port");
			const url = `http://127.0.0.1:${address.port}`;
			const environment = {
				PATH: process.env.PATH,
				CEX_BROKER_ARCHIVE_ENABLED: String(archiveEnabled),
				CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH: journal,
				...(!archiveEnabled
					? { CEX_BROKER_ARCHIVE_DEAD_LETTER_EXPORT_PATH: exported }
					: {}),
				CEX_BROKER_ARCHIVE_FORWARDER_URL: url,
				CEX_BROKER_ARCHIVE_OTEL_LOGS_ENABLED: "true",
				CEX_BROKER_OTEL_HOST: "127.0.0.1",
				CEX_BROKER_OTEL_PORT: String(address.port),
				OTEL_EXPORTER_OTLP_ENDPOINT: url,
				OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${url}/v1/logs`,
				OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${url}/v1/metrics`,
			};
			const source = new URL("../src/index.ts", import.meta.url).href;
			const child = Bun.spawn(
				[
					process.execPath,
					"--eval",
					`
				const { default: CEXBroker } = await import(${JSON.stringify(source)});
				const broker = new CEXBroker({}, {
					withdraw: { rule: [] }, deposit: {}, order: { rule: { markets: [], limits: [] } },
				});
				await broker.stop();
			`,
				],
				{
					env: packageConsumerEnvironment(environment),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const timeout = setTimeout(() => child.kill(), 10_000);
			try {
				const [exitCode] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(exitCode).toBe(0);
			} finally {
				clearTimeout(timeout);
			}
			expect(connections).toBe(0);
			expect(readdirSync(directory)).toEqual(
				archiveEnabled ? [] : ["journal.jsonl"],
			);
			if (!archiveEnabled)
				expect(readFileSync(journal, "utf8")).toBe("fixture-journal\n");
		} finally {
			await new Promise<void>((resolve, reject) =>
				endpoint.close((error) => (error ? reject(error) : resolve())),
			);
			rmSync(directory, { recursive: true, force: true });
		}
	}, 15_000);
}
