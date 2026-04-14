#!/usr/bin/env bun

import { Command } from "commander";
import { config } from "dotenv";
import { probeAuthCommand } from "./commands/probe-auth";
import { startBrokerCommand } from "./commands/start-broker";

const program = new Command();
config();

const isValidIPv4 = (ip: string) =>
	/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
	ip.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);

program
	.name("cex-broker")
	.description("CLI for the CEXBroker service")
	.option("-p, --policy <path>", "Policy JSON file")
	.option("--port <number>", "Port number (default: 8086)", "8086")
	.option(
		"-w, --whitelist <addresses...>",
		"IPv4 address whitelist (space-separated list)",
	)
	.option("--whitelistAll", "Allow all IPv4 addresses (development mode)")
	.option("--verityProverUrl <url>", "Verity Prover Url")
	.option(
		"--probeAuth <exchange>",
		"Probe auth for an env-configured exchange without starting the server",
	)
	.option(
		"--account <selector>",
		'Account selector to probe, e.g. "primary" or "secondary:1"',
		"primary",
	)
	.action(async (options) => {
		try {
			if (options.probeAuth) {
				await probeAuthCommand(options.probeAuth, options.account);
				return;
			}

			if (!options.policy) {
				console.error("❌ --policy is required unless --probeAuth is used");
				process.exit(1);
			}

			const whitelist: string[] = options.whitelistAll
				? ["*"]
				: (options.whitelist ?? []);

			// Optional: Validate IPv4 addresses unless wildcard is used
			if (whitelist.length > 0 && !whitelist.includes("*")) {
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
