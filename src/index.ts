import * as grpc from "@grpc/grpc-js";
import ccxt, { type Exchange } from "@usherlabs/ccxt";
import { unwatchFile, watchFile } from "fs";
import Joi from "joi";
import {
	type BrokerPoolEntry,
	createBroker,
	createBrokerPool,
	loadPolicy,
	normalizePolicyConfig,
	resolveBrokerAccount,
} from "./helpers";
import { log } from "./helpers/logger";
import {
	createOtelLogsFromEnv,
	createOtelMetricsFromEnv,
	type OtelConfig,
	OtelLogs,
	OtelMetrics,
} from "./helpers/otel";
import { getServer } from "./server";
import {
	type BrokerCredentials,
	BrokerList,
	type ExchangeCredentials,
	type PolicyConfig,
} from "./types";

export type { PolicyConfig } from "./types";

export type BrokerAuthProbeStep = {
	success: boolean;
	error?: string;
};

export type BrokerAuthProbeResult = {
	exchange: string;
	mode: "configured" | "raw";
	selector?: string;
	resolvedAccount?: string;
	role?: "master" | "subaccount";
	fetchAccountId: BrokerAuthProbeStep & {
		accountId?: string;
	};
	fetchBalance: BrokerAuthProbeStep & {
		assetCount?: number;
	};
};

log.info("CCXT Version:", ccxt.version);

export default class CEXBroker {
	#brokerConfig: ExchangeCredentials = {};
	#policyFilePath?: string;
	#verityProverUrl: string = "http://localhost:8080";
	port = 8086;
	private policy: PolicyConfig;
	private brokers: Record<string, BrokerPoolEntry> = {};
	private whitelistIps: string[] = [
		"127.0.0.1", // localhost
		"::1", // IPv6 localhost
	];

	private server: grpc.Server | null = null;
	private useVerity: boolean = false;
	private otelMetrics?: OtelMetrics;
	private otelLogs?: OtelLogs;

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
				_secondaryMap?: Record<number, Partial<BrokerCredentials>>;
			}
		> = {};

		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("CEX_BROKER_")) continue;

			// Match secondary keys like API_KEY_1, ROLE_1, EMAIL_1
			let match = key.match(
				/^CEX_BROKER_(\w+)_(API_(KEY|SECRET)|ROLE|EMAIL|SUBACCOUNTID|UID)_(\d+)$/,
			);
			if (match) {
				const broker = match[1]?.toLowerCase() ?? "";
				const type = match[2]?.toLowerCase() ?? "";
				const index = Number(match[4]?.toLowerCase());

				if (!configMap[broker]) configMap[broker] = {};
				if (!configMap[broker]._secondaryMap)
					configMap[broker]._secondaryMap = {};
				if (!configMap[broker]._secondaryMap[index])
					configMap[broker]._secondaryMap[index] = {};

				if (type === "api_key") {
					configMap[broker]._secondaryMap[index].apiKey = value || "";
				} else if (type === "api_secret") {
					configMap[broker]._secondaryMap[index].apiSecret = value || "";
				} else if (type === "role") {
					const role = value?.trim().toLowerCase();
					if (role === "master" || role === "subaccount") {
						configMap[broker]._secondaryMap[index].role = role;
					}
				} else if (type === "email") {
					configMap[broker]._secondaryMap[index].email = value || "";
				} else if (type === "subaccountid") {
					configMap[broker]._secondaryMap[index].subAccountId = value || "";
				} else if (type === "uid") {
					configMap[broker]._secondaryMap[index].uid = value || "";
				}
				continue;
			}

			match = key.match(
				/^CEX_BROKER_(\w+)_(API_(KEY|SECRET)|ROLE|EMAIL|SUBACCOUNTID|UID)$/,
			);
			if (!match) {
				log.warn(`⚠️ Skipping unrecognized env var: ${key}`);
				continue;
			}

			const broker = match[1]?.toLowerCase() ?? ""; // normalize to lowercase
			const type = match[2]?.toLowerCase() ?? "";

			if (!configMap[broker]) {
				configMap[broker] = {};
			}

			if (type === "api_key") {
				configMap[broker].apiKey = value || "";
			} else if (type === "api_secret") {
				configMap[broker].apiSecret = value || "";
			} else if (type === "role") {
				const role = value?.trim().toLowerCase();
				if (role === "master" || role === "subaccount") {
					configMap[broker].role = role;
				}
			} else if (type === "email") {
				configMap[broker].email = value || "";
			} else if (type === "subaccountid") {
				configMap[broker].subAccountId = value || "";
			} else if (type === "uid") {
				configMap[broker].uid = value || "";
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
					role: Joi.string().valid("master", "subaccount").optional(),
					email: Joi.string().optional(),
					subAccountId: Joi.string().optional(),
					uid: Joi.string().optional(),
					secondaryKeys: Joi.array()
						.items(
							Joi.object({
								apiKey: Joi.string().required(),
								apiSecret: Joi.string().required(),
								role: Joi.string().valid("master", "subaccount").optional(),
								email: Joi.string().optional(),
								subAccountId: Joi.string().optional(),
								uid: Joi.string().optional(),
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

	public getBrokerAccount(exchangeName: string, selector = "primary") {
		const normalizedExchange = exchangeName.trim().toLowerCase();
		const brokerEntry = this.brokers[normalizedExchange];
		if (!brokerEntry) {
			throw new Error(`Exchange "${normalizedExchange}" is not configured`);
		}

		const account = resolveBrokerAccount(brokerEntry, selector);
		if (!account) {
			throw new Error(
				`Account selector "${selector}" is not configured for "${normalizedExchange}"`,
			);
		}

		return {
			exchangeName: normalizedExchange,
			account,
		};
	}

	public async probeAuth(
		exchangeName: string,
		selector = "primary",
	): Promise<BrokerAuthProbeResult> {
		const { exchangeName: normalizedExchange, account } = this.getBrokerAccount(
			exchangeName,
			selector,
		);

		return this.runProbeAuthSteps(normalizedExchange, account.exchange, {
			mode: "configured",
			selector,
			resolvedAccount: account.label,
			role: account.role,
		});
	}

	public async probeAuthWithCredentials(
		exchangeName: string,
		creds: { apiKey: string; apiSecret: string },
	): Promise<BrokerAuthProbeResult> {
		const normalizedExchange = exchangeName.trim().toLowerCase();
		const exchange = createBroker(normalizedExchange, creds);
		if (!exchange) {
			throw new Error(
				`Failed to create probe broker for "${normalizedExchange}" with provided credentials`,
			);
		}

		return this.runProbeAuthSteps(normalizedExchange, exchange, {
			mode: "raw",
		});
	}

	private async runProbeAuthSteps(
		exchangeName: string,
		exchange: Exchange,
		context: Pick<
			BrokerAuthProbeResult,
			"mode" | "selector" | "resolvedAccount" | "role"
		>,
	): Promise<BrokerAuthProbeResult> {
		const result: BrokerAuthProbeResult = {
			exchange: exchangeName,
			mode: context.mode,
			selector: context.selector,
			resolvedAccount: context.resolvedAccount,
			role: context.role,
			fetchAccountId: {
				success: false,
			},
			fetchBalance: {
				success: false,
			},
		};

		try {
			const accountId = await exchange.fetchAccountId();
			result.fetchAccountId = {
				success: true,
				accountId,
			};
		} catch (error) {
			result.fetchAccountId = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		try {
			const balance = await exchange.fetchBalance({ type: "spot" });
			const total = balance.total ?? {};
			const assetCount = Object.values(total).filter(
				(value) => value !== undefined && value !== null,
			).length;
			result.fetchBalance = {
				success: true,
				assetCount,
			};
		} catch (error) {
			result.fetchBalance = {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		return result;
	}

	constructor(
		apiCredentials: ExchangeCredentials,
		policies: string | PolicyConfig,
		config?: {
			port?: number;
			whitelistIps?: string[];
			useVerity?: boolean;
			verityProverUrl?: string;
			otelConfig?: OtelConfig;
		},
	) {
		this.useVerity = config?.useVerity || false;

		if (typeof policies === "string") {
			this.#policyFilePath = policies;
			this.policy = loadPolicy(policies);
			this.port = config?.port ?? 8086;
		} else {
			this.policy = normalizePolicyConfig(policies);
		}

		// If monitoring a file, start watcher
		if (this.#policyFilePath) {
			this.watchPolicyFile(this.#policyFilePath);
		}
		this.#verityProverUrl = config?.verityProverUrl || "http://localhost:8080";

		// Initialize OTel metrics if config provided
		if (config?.otelConfig) {
			this.otelMetrics = new OtelMetrics(config.otelConfig);
			this.otelLogs = new OtelLogs(config.otelConfig);
		} else {
			// Try to create from environment variables
			this.otelMetrics = createOtelMetricsFromEnv();
			this.otelLogs = createOtelLogsFromEnv();
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
		if (this.otelMetrics) {
			await this.otelMetrics.close();
		}
		if (this.otelLogs) {
			await this.otelLogs.close();
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

		// Initialize OTel metrics if enabled
		if (this.otelMetrics?.isOtelEnabled()) {
			await this.otelMetrics.initialize();
		}

		this.server = getServer(
			this.policy,
			this.brokers,
			this.whitelistIps,
			this.useVerity,
			this.#verityProverUrl,
			this.otelMetrics,
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
