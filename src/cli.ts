#!/usr/bin/env bun

import { Command } from "commander";
import { startBrokerCommand } from "./commands/start-broker";
import { log } from "./helpers/logger";

const program = new Command();

program
	.name("cex-broker")
	.description("CLI to start the CEXBroker service")
	.requiredOption("-p, --policy <path>", "Policy JSON file")
	.option("--port <number>", "Port number (default: 8086)", "8086")
	.option(
		"-w, --whitelist <addresses...>",
		"IPv4 address whitelist (space-separated list)",
	)
	.option("--whitelistAll", "Allow all IPv4 addresses (development mode)")
	.option("--verityProverUrl <url>", "Verity Prover Url")
	.action(async (options) => {
		try {
			const whitelist: string[] = options.whitelistAll
				? ["*"]
				: (options.whitelist ?? []);

			// Optional: Validate IPv4 addresses unless wildcard is used
			if (whitelist.length > 0 && !whitelist.includes("*")) {
				const isValidIPv4 = (ip: string) =>
					/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
					ip
						.split(".")
						.every((part) => Number(part) >= 0 && Number(part) <= 255);

				for (const ip of whitelist) {
					if (!isValidIPv4(ip)) {
						throw new Error(`Invalid IPv4 address: ${ip}`);
					}
				}
			}

			const broker = await startBrokerCommand(
				options.policy,
				parseInt(options.port, 10),
				whitelist, // Pass whitelist to your command,
				options.verityProverUrl,
			);
			let shutdownPromise: Promise<void> | undefined;
			const onSignal = (signal: NodeJS.Signals): void => {
				if (shutdownPromise) return;
				log
					.withMetadata({ signal })
					.info("CEXBroker graceful shutdown requested");
				shutdownPromise = (async () => {
					try {
						await broker.stop();
						log
							.withMetadata({ signal })
							.info("CEXBroker graceful shutdown complete");
						process.exitCode = 0;
					} catch (error) {
						log
							.withMetadata({ signal, error })
							.error("CEXBroker graceful shutdown failed");
						process.exitCode = 1;
					} finally {
						process.off("SIGTERM", onSignal);
						process.off("SIGINT", onSignal);
					}
				})();
			};
			process.on("SIGTERM", onSignal);
			process.on("SIGINT", onSignal);
		} catch (err) {
			console.error("❌ Failed to start broker:", err);
			process.exitCode = 1;
		}
	});

await program.parseAsync(process.argv);
