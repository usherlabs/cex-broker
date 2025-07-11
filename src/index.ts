import ccxt, { type Exchange } from "ccxt";
import * as grpc from "@grpc/grpc-js";
import { watchFile, unwatchFile } from "fs";
import Joi from "joi";
import { loadPolicy } from "./helpers";
import {
	BrokerList,
	type BrokerCredentials,
	type ExchangeCredentials,
	type PolicyConfig,
} from "../types";
import { getServer } from "./server";

console.log("CCXT Version:", ccxt.version);

export default class CEXBroker {
	#brokerConfig: Record<string, BrokerCredentials> = {};
	#policyFilePath?: string;
	port = 8086;
	private policy: PolicyConfig;
	private brokers: Record<string, Exchange> = {};
	private whitelistIps: string[] = [
		"127.0.0.1", // localhost
		"::1", // IPv6 localhost
	];

	private server: grpc.Server | null = null;

	/**
	 * Loads environment variables prefixed with CEX_BROKER_
	 * Expected format:
	 *   CEX_BROKER_<BROKER_NAME>_API_KEY
	 *   CEX_BROKER_<BROKER_NAME>_API_SECRET
	 */
	public loadEnvConfig(): void {
		console.log("🔧 Loading CEX_BROKER_ environment variables:");
		const configMap: Record<string, Partial<BrokerCredentials>> = {};

		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("CEX_BROKER_")) continue;

			const match: any = key.match(/^CEX_BROKER_(\w+)_API_(KEY|SECRET)$/);
			if (!match) {
				console.warn(`⚠️ Skipping unrecognized env var: ${key}`);
				continue;
			}

			const broker = match[1].toLowerCase(); // normalize to lowercase
			const type = match[2].toLowerCase(); // 'key' or 'secret'

			if (!configMap[broker]) {
				configMap[broker] = {};
			}

			if (type === "key") {
				configMap[broker].apiKey = value || "";
			} else if (type === "secret") {
				configMap[broker].apiSecret = value || "";
			}
		}

		if (Object.keys(configMap).length === 0) {
			console.error(`❌ NO CEX Broker Key Found`);
		}

		// Finalize config and print result per broker
		for (const [broker, creds] of Object.entries(configMap)) {
			const hasKey = !!creds.apiKey;
			const hasSecret = !!creds.apiSecret;

			if (hasKey && hasSecret) {
				this.#brokerConfig[broker] = {
					apiKey: creds.apiKey ?? "",
					apiSecret: creds.apiSecret ?? "",
				};
				console.log(`✅ Loaded credentials for broker "${broker}"`);
				const ExchangeClass = (ccxt as any)[broker];
				const client = new ExchangeClass({
					apiKey: creds.apiKey,
					secret: creds.apiSecret,
					enableRateLimit: true,
					defaultType: "spot",
				});
				this.brokers[broker] = client;
			} else {
				const missing = [];
				if (!hasKey) missing.push("API_KEY");
				if (!hasSecret) missing.push("API_SECRET");
				console.warn(
					`❌ Missing ${missing.join(" and ")} for broker "${broker}"`,
				);
			}
		}
	}

	/**
	 * Validates an exc hange credential object structure.
	 */
	public loadExchangeCredentials(
		creds: unknown,
	): asserts creds is ExchangeCredentials {
		const schema = Joi.object<Record<string, BrokerCredentials>>()
			.pattern(
				Joi.string()
					.allow(...BrokerList)
					.required(),
				Joi.object({
					apiKey: Joi.string().required(),
					apiSecret: Joi.string().required(),
				}),
			)
			.required();

		const { value, error } = schema.validate(creds);
		if (error) {
			throw new Error(`Invalid credentials format: ${error.message}`);
		}

		// Finalize config and print result per broker
		for (const [broker, creds] of Object.entries(value)) {
			console.log(`✅ Loaded credentials for broker "${broker}"`);
			const ExchangeClass = (ccxt as any)[broker];
			const client = new ExchangeClass({
				apiKey: creds.apiKey,
				secret: creds.apiSecret,
				enableRateLimit: true,
				defaultType: "spot",
			});
			this.brokers[broker] = client;
		}
	}

	constructor(
		apiCredentials: ExchangeCredentials,
		policies: string | PolicyConfig,
		config?: { port: number; whitelistIps: string[] },
	) {
		if (typeof policies === "string") {
			this.#policyFilePath = policies;
			this.policy = loadPolicy(policies);
			this.port = config?.port ?? 8086;
		} else {
			this.policy = policies;
		}

		// If monitoring a file, start watcher
		if (this.#policyFilePath) {
			this.watchPolicyFile(this.#policyFilePath);
		}

		this.loadExchangeCredentials(apiCredentials);
		this.whitelistIps = [
			...(config ?? { whitelistIps: [] }).whitelistIps,
			...this.whitelistIps,
		];
	}

	/**
	 * Watches the policy JSON file for changes, reloads policies, and reruns broker.
	 * @param filePath
	 */
	private watchPolicyFile(filePath: string): void {
		watchFile(filePath, { interval: 1000 }, (curr, prev) => {
			if (curr.mtime > prev.mtime) {
				try {
					const updated = loadPolicy(filePath);
					this.policy = updated;
					console.log(
						`Policies reloaded from ${filePath} at ${new Date().toISOString()}`,
					);
					// Rerun broker with updated policies
					this.run();
				} catch (err) {
					console.error(`Error reloading policies: ${err}`);
				}
			}
		});
	}

	/**
	 * Stops Server and Stop watching the policy file, if applicable.
	 */
	public stop(): void {
		if (this.#policyFilePath) {
			unwatchFile(this.#policyFilePath);
			console.log(`Stopped watching policy file: ${this.#policyFilePath}`);
		}
		if (this.server) {
			this.server.forceShutdown();
		}
	}

	/**
	 * Starts the broker, applying policies then running appropriate tasks.
	 */
	public async run(): Promise<CEXBroker> {
		if (this.server) {
			await this.server.forceShutdown();
		}
		console.log(`Running CEXBroker at ${new Date().toISOString()}`);
		this.server = getServer(this.policy, this.brokers, this.whitelistIps);

		this.server.bindAsync(
			`0.0.0.0:${this.port}`,
			grpc.ServerCredentials.createInsecure(),
			(err, port) => {
				if (err) {
					console.error(err);
					return;
				}
				console.log(`Your server as started on port ${port}`);
			},
		);
		return this;
	}
}
