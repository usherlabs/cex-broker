import * as grpc from "@grpc/grpc-js";
import ccxt, { type Exchange } from "@usherlabs/ccxt";
import { unwatchFile, watchFile } from "fs";
import Joi from "joi";
import { loadPolicy, createBrokerPool } from "./helpers";
import { log } from "./helpers/logger";
import { getServer } from "./server";
import {
	type BrokerCredentials,
	BrokerList,
	type ExchangeCredentials,
	type PolicyConfig,
} from "./types";
import {
	ClickHouseMetrics,
	createClickHouseMetricsFromEnv,
	type ClickHouseConfig,
} from "./helpers/clickhouse";

log.info("CCXT Version:", ccxt.version);

export default class CEXBroker {
	#brokerConfig: ExchangeCredentials = {};
	#policyFilePath?: string;
	#verityProverUrl: string = "http://localhost:8080";
	port = 8086;
	private policy: PolicyConfig;
	private brokers: Record<
		string,
		{ primary: Exchange; secondaryBrokers: Exchange[] }
	> = {};
	private whitelistIps: string[] = [
		"127.0.0.1", // localhost
		"::1", // IPv6 localhost
	];

	private server: grpc.Server | null = null;
	private useVerity: boolean = false;
	private clickhouseMetrics?: ClickHouseMetrics;

	/**
	 * Loads environment variables prefixed with CEX_BROKER_
	 * Expected format:
	 *   CEX_BROKER_<BROKER_NAME>_API_KEY
	 *   CEX_BROKER_<BROKER_NAME>_API_SECRET
	 */
	public loadEnvConfig(): void {
		log.info("🔧 Loading CEX_BROKER_ environment variables:");
		const configMap: Record<
			string,
			Partial<BrokerCredentials> & {
				_secondaryMap?: Record<number, { apiKey?: string; apiSecret?: string }>;
			}
		> = {};

		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("CEX_BROKER_")) continue;

			// Match secondary keys like API_KEY_1, API_SECRET_1
			let match = key.match(/^CEX_BROKER_(\w+)_API_(KEY|SECRET)_(\d+)$/);
			if (match) {
				const broker = match[1]?.toLowerCase() ?? "";
				const type = match[2]?.toLowerCase();
				const index = Number(match[3]?.toLowerCase());

				if (!configMap[broker]) configMap[broker] = {};
				if (!configMap[broker]._secondaryMap)
					configMap[broker]._secondaryMap = {};
				if (!configMap[broker]._secondaryMap[index])
					configMap[broker]._secondaryMap[index] = {};

				if (type === "key") {
					configMap[broker]._secondaryMap[index].apiKey = value || "";
				} else if (type === "secret") {
					configMap[broker]._secondaryMap[index].apiSecret = value || "";
				}
				continue;
			}

			match = key.match(/^CEX_BROKER_(\w+)_API_(KEY|SECRET)$/);
			if (!match) {
				log.warn(`⚠️ Skipping unrecognized env var: ${key}`);
				continue;
			}

			const broker = match[1]?.toLowerCase() ?? ""; // normalize to lowercase
			const type = match[2]?.toLowerCase() ?? ""; // 'key' or 'secret'

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
			log.warn(`❌ NO CEX Broker Key Found`);
		}

		// Build pool centrally
		this.brokers = createBrokerPool(configMap);
	}

	/**
	 * Validates an exchange credential object structure.
	 */
	public loadExchangeCredentials(
		creds: unknown,
	): asserts creds is ExchangeCredentials {
		const schema = Joi.object<
			Record<string, BrokerCredentials & { secondaryKeys: BrokerCredentials[] }>
		>()
			.pattern(
				Joi.string()
					.allow(...BrokerList)
					.required(),
				Joi.object({
					apiKey: Joi.string().required(),
					apiSecret: Joi.string().required(),
					secondaryKeys: Joi.array()
						.items(
							Joi.object({
								apiKey: Joi.string().required(),
								apiSecret: Joi.string().required(),
							}),
						)
						.default([]),
				}),
			)
			.required();

		const { value, error } = schema.validate(creds);
		if (error) {
			throw new Error(`Invalid credentials format: ${error.message}`);
		}

		// Build pool centrally
		this.brokers = createBrokerPool(value);
	}

	constructor(
		apiCredentials: ExchangeCredentials,
		policies: string | PolicyConfig,
		config?: {
			port?: number;
			whitelistIps?: string[];
			useVerity?: boolean;
			verityProverUrl?: string;
			clickhouseConfig?: ClickHouseConfig;
		},
	) {
		this.useVerity = config?.useVerity || false;

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
		this.#verityProverUrl = config?.verityProverUrl || "http://localhost:8080";

		// Initialize ClickHouse metrics if config provided
		if (config?.clickhouseConfig) {
			this.clickhouseMetrics = new ClickHouseMetrics(config.clickhouseConfig);
		} else {
			// Try to create from environment variables
			this.clickhouseMetrics = createClickHouseMetricsFromEnv();
		}

		this.loadExchangeCredentials(apiCredentials);
		this.whitelistIps = [
			...((config ?? { whitelistIps: [] }).whitelistIps ?? []),
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
					log.info(
						`Policies reloaded from ${filePath} at ${new Date().toISOString()}`,
					);
					// Rerun broker with updated policies
					this.run();
				} catch (err) {
					log.error(`Error reloading policies: ${err}`);
				}
			}
		});
	}

	/**
	 * Stops Server and Stop watching the policy file, if applicable.
	 */
	public async stop(): Promise<void> {
		if (this.#policyFilePath) {
			unwatchFile(this.#policyFilePath);
			log.info(`Stopped watching policy file: ${this.#policyFilePath}`);
		}
		if (this.server) {
			await this.server.forceShutdown();
		}
		if (this.clickhouseMetrics) {
			await this.clickhouseMetrics.close();
		}
	}

	/**
	 * Starts the broker, applying policies then running appropriate tasks.
	 */
	public async run(): Promise<CEXBroker> {
		if (this.server) {
			await this.server.forceShutdown();
		}
		log.info(`Running CEXBroker at ${new Date().toISOString()}`);

		// Initialize ClickHouse database/table if enabled
		if (this.clickhouseMetrics?.isClickHouseEnabled()) {
			await this.clickhouseMetrics.initialize();
		}

		this.server = getServer(
			this.policy,
			this.brokers,
			this.whitelistIps,
			this.useVerity,
			this.#verityProverUrl,
			this.clickhouseMetrics,
		);

		this.server.bindAsync(
			`0.0.0.0:${this.port}`,
			grpc.ServerCredentials.createInsecure(),
			(err, port) => {
				if (err) {
					log.error(err);
					return;
				}
				log.info(`Your server as started on port ${port}`);
			},
		);
		return this;
	}
}
