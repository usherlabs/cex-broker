#!/usr/bin/env bun

import { Command } from "commander";
import { startBrokerCommand } from "./commands/start-broker";

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
						console.error(`❌ Invalid IPv4 address: ${ip}`);
						process.exit(1);
					}
				}
			}

			await startBrokerCommand(
				options.policy,
				parseInt(options.port, 10),
				whitelist, // Pass whitelist to your command,
				options.verityProverUrl,
			);
		} catch (err) {
			console.error("❌ Failed to start broker:", err);
			process.exit(1);
		}
	});

program.parse(process.argv);
