import { expect, test } from "bun:test";
import { createServer } from "node:net";
import * as grpc from "@grpc/grpc-js";
import CEXBroker from "../src/index";
import { CEX_BROKER_PACKAGE_DEFINITION } from "../src/proto-package-definition";
import type { PolicyConfig } from "../src/types";

type FullBrokerClient = grpc.Client & {
	ExecuteAction(
		request: Record<string, unknown>,
		callback: (error: grpc.ServiceError | null, response?: unknown) => void,
	): void;
	Subscribe(
		request: Record<string, unknown>,
	): grpc.ClientReadableStream<{ data: string }>;
};

const grpcObject = grpc.loadPackageDefinition(
	CEX_BROKER_PACKAGE_DEFINITION,
) as unknown as {
	cex_broker: {
		cex_service: new (
			address: string,
			credentials: grpc.ChannelCredentials,
		) => FullBrokerClient;
	};
};

const policy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

const captureEnvKeys = [
	"CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT",
	"CEX_BROKER_ARCHIVE_ENABLED",
	"CEX_BROKER_ARCHIVE_SOURCE",
	"CEX_BROKER_DEPLOYMENT_ID",
	"CEX_BROKER_CAPTURE_BUNDLE_ID",
	"CEX_BROKER_ARCHIVE_FORWARDER_URL",
	"CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH",
] as const;

function captureEnvironment(): Record<string, string | undefined> {
	return Object.fromEntries(
		captureEnvKeys.map((key) => [key, process.env[key]]),
	);
}

function restoreEnvironment(
	original: Record<string, string | undefined>,
): void {
	for (const key of captureEnvKeys) {
		const value = original[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

async function reservePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Failed to reserve a TCP port");
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return address.port;
}

function waitForReady(client: grpc.Client): Promise<void> {
	return new Promise((resolve, reject) => {
		client.waitForReady(Date.now() + 3_000, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function expectFullRpcService(client: FullBrokerClient): Promise<void> {
	const executeError = await new Promise<grpc.ServiceError | null>(
		(resolve) => {
			client.ExecuteAction({}, (error) => resolve(error));
		},
	);
	expect(executeError?.code).toBe(grpc.status.INVALID_ARGUMENT);

	const subscribeFrame = await new Promise<{ data: string }>(
		(resolve, reject) => {
			const stream = client.Subscribe({});
			stream.once("data", resolve);
			stream.once("error", reject);
		},
	);
	expect(JSON.parse(subscribeFrame.data)).toEqual({
		error: "cex, symbol, and type are required",
	});
}

test("production broker starts its full RPC service without archive configuration", async () => {
	const original = captureEnvironment();
	let broker: CEXBroker | undefined;
	let client: FullBrokerClient | undefined;
	try {
		for (const key of captureEnvKeys) delete process.env[key];
		process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT = "production";
		const port = await reservePort();
		broker = new CEXBroker({}, policy);
		broker.port = port;
		await broker.run();
		client = new grpcObject.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);
		await waitForReady(client);
		await expectFullRpcService(client);
	} finally {
		client?.close();
		await broker?.stop();
		restoreEnvironment(original);
	}
});

test("incomplete production market provenance does not gate the full RPC service", async () => {
	const original = captureEnvironment();
	const deadLetterPath = `/tmp/cex-broker-production-ineligible-${crypto.randomUUID()}.jsonl`;
	let broker: CEXBroker | undefined;
	let client: FullBrokerClient | undefined;
	try {
		const port = await reservePort();
		process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT = "production";
		process.env.CEX_BROKER_ARCHIVE_ENABLED = "true";
		process.env.CEX_BROKER_ARCHIVE_SOURCE = "broker_write";
		delete process.env.CEX_BROKER_DEPLOYMENT_ID;
		delete process.env.CEX_BROKER_CAPTURE_BUNDLE_ID;
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL = "http://127.0.0.1:1/archive";
		process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH = deadLetterPath;

		broker = new CEXBroker({}, policy);
		broker.port = port;
		await broker.run();
		client = new grpcObject.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);
		await waitForReady(client);
		await expectFullRpcService(client);
	} finally {
		client?.close();
		await broker?.stop();
		restoreEnvironment(original);
		if (await Bun.file(deadLetterPath).exists()) {
			await Bun.file(deadLetterPath).delete();
		}
	}
});

test.each([
	"broker_read",
	"broker_write",
] as const)("valid production %s provenance starts the unchanged full broker RPC service", async (source) => {
	const original = captureEnvironment();
	const deadLetterPath = `/tmp/cex-broker-production-${source}-${crypto.randomUUID()}.jsonl`;
	let broker: CEXBroker | undefined;
	let client: FullBrokerClient | undefined;
	try {
		const port = await reservePort();
		process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT = "production";
		process.env.CEX_BROKER_ARCHIVE_ENABLED = "true";
		process.env.CEX_BROKER_ARCHIVE_SOURCE = source;
		process.env.CEX_BROKER_DEPLOYMENT_ID = "collector-a";
		process.env.CEX_BROKER_CAPTURE_BUNDLE_ID = "bundle-a";
		process.env.CEX_BROKER_ARCHIVE_FORWARDER_URL = "http://127.0.0.1:1/archive";
		process.env.CEX_BROKER_ARCHIVE_DEAD_LETTER_PATH = deadLetterPath;

		broker = new CEXBroker({}, policy);
		broker.port = port;
		await broker.run();
		client = new grpcObject.cex_broker.cex_service(
			`127.0.0.1:${port}`,
			grpc.credentials.createInsecure(),
		);
		await waitForReady(client);
		await expectFullRpcService(client);
	} finally {
		client?.close();
		await broker?.stop();
		restoreEnvironment(original);
		if (await Bun.file(deadLetterPath).exists()) {
			await Bun.file(deadLetterPath).delete();
		}
	}
});
