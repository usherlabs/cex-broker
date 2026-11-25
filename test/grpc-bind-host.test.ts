import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import * as grpc from "@grpc/grpc-js";
import { resolveGrpcBindHost } from "../src/helpers/grpc/bind-host";

const environment = {
	PATH: process.env.PATH,
	NODE_ENV: "test",
};

function startCli(port: number, envHost?: string, cliHost?: string) {
	return Bun.spawn({
		cmd: [
			process.execPath,
			"--no-env-file",
			"src/cli.ts",
			"--policy",
			"policy/policy.json",
			"--port",
			String(port),
			"--whitelistAll",
			"--unary-market-only",
			...(cliHost === undefined ? [] : ["--bind-host", cliHost]),
		],
		env: { ...environment, CEX_BROKER_GRPC_BIND_HOST: envHost },
		stdout: "ignore",
		stderr: "pipe",
	});
}

async function probeBind(host: string, port = 0): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	try {
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Test server did not bind to a TCP port");
		}
		return address.port;
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function otherIPv4Address(): string {
	return (
		Object.values(networkInterfaces())
			.flat()
			.find((address) => address?.family === "IPv4" && !address.internal)
			?.address ?? "127.0.0.2"
	);
}

test("gRPC bind host defaults to the IPv4 wildcard", () => {
	expect(resolveGrpcBindHost(undefined, undefined)).toBe("0.0.0.0");
});

test.each([
	"",
	" ",
	"localhost",
	"127.0.0.1:8086",
	"[::1]",
	"fe80::1%eth0",
	"https://127.0.0.1",
	"127.0.0.256",
])("gRPC bind host rejects malformed IP address %j", (host) => {
	expect(() => resolveGrpcBindHost(host, "127.0.0.1")).toThrow(
		"Invalid gRPC bind host",
	);
	expect(() => resolveGrpcBindHost(undefined, host)).toThrow(
		"Invalid gRPC bind host",
	);
});

test.each([
	{ host: "127.0.0.1", envHost: "127.0.0.1", cliHost: undefined },
	{ host: "::1", envHost: "not-an-ip", cliHost: "::1" },
])("gRPC listens only on the selected loopback address ($host)", async ({
	host,
	envHost,
	cliHost,
}) => {
	const port = await probeBind(host);
	const child = startCli(port, envHost, cliHost);
	const address = host === "::1" ? `[::1]:${port}` : `127.0.0.1:${port}`;
	const client = new grpc.Client(address, grpc.credentials.createInsecure(), {
		"grpc.enable_http_proxy": 0,
	});
	try {
		await new Promise<void>((resolve, reject) => {
			client.waitForReady(Date.now() + 3_000, (error) =>
				error ? reject(error) : resolve(),
			);
		});
		// A wildcard listener would prevent binding the same port on this separate address.
		const otherHost = host === "::1" ? "127.0.0.1" : otherIPv4Address();
		expect(await probeBind(otherHost, port)).toBe(port);
	} finally {
		client.close();
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
});

test("the CLI rejects an invalid environment bind host before starting", async () => {
	const child = startCli(0, "127.0.0.1:8086");
	try {
		const result = await Promise.race([
			child.exited,
			Bun.sleep(3_000).then(() => null),
		]);
		expect(result).toBe(1);
		expect(await new Response(child.stderr).text()).toContain(
			"Invalid gRPC bind host",
		);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
});
