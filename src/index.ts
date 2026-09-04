import * as grpc from "@grpc/grpc-js";
import ccxt from "@usherlabs/ccxt";
import { unwatchFile, watchFile } from "fs";
import Joi from "joi";
import {
	type BrokerPoolEntry,
	createBrokerPool,
	loadPolicy,
	loadTravelRuleDepositReconcilerConfigFromEnv,
	normalizePolicyConfig,
	TravelRuleDepositReconciler,
} from "./helpers";
import { AccountBalanceArchivePoller } from "./helpers/account-balance-archive-poller";
import { BalanceUpdateArchiveConsumer } from "./helpers/balance-update-archive-consumer";
import {
	type BrokerExecutionArchiver,
	createBrokerExecutionArchiverFromEnv,
	WithdrawalObservationTracker,
} from "./helpers/broker-execution-archive";
import { DepositArchivePoller } from "./helpers/deposit-archive-poller";
import { FillArchivePoller } from "./helpers/fill-archive-poller";
import { log } from "./helpers/logger";
import {
	assertMarketCaptureArchiveStartable,
	resolveMarketCaptureArchiveState,
} from "./helpers/market-data-archive/capture-context";
import { isMarketArchiveEnabled } from "./helpers/market-data-archive/orderbook-sampler";
import { OrderActivityTracker } from "./helpers/order-activity-tracker";
import {
	createOtelLogsFromEnv,
	createOtelMetricsFromEnv,
	type OtelConfig,
	OtelLogs,
	OtelMetrics,
} from "./helpers/otel";
import { PublicMarketDataFeedSupervisor } from "./helpers/public-market-data-feed";
import {
	StreamHealthPublisher,
	streamHealthPublisherConfigFromEnv,
} from "./helpers/stream-health-publisher";
import { UserAssetArchivePoller } from "./helpers/user-asset-archive-poller";
import { UserDataStreamSupervisor } from "./helpers/user-data-stream-supervisor";
import { getServer } from "./server";
import {
	type BrokerCredentials,
	BrokerList,
	type ExchangeCredentials,
	type PolicyConfig,
} from "./types";

export type { PolicyConfig } from "./types";

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
	private brokerArchiver?: BrokerExecutionArchiver;
	private depositReconciler?: TravelRuleDepositReconciler;
	// Order activity feeds the fill poller its per-market poll set; shared with the
	// execute-action handler so orders record the (account, symbol) they touch.
	private readonly orderActivityTracker = new OrderActivityTracker();
	// Persist across server rebuilds on policy reload so repeated venue polling is
	// suppressed for the lifetime of this broker process.
	private readonly withdrawalObservationTracker =
		new WithdrawalObservationTracker();
	private fillArchivePoller?: FillArchivePoller;
	private depositArchivePoller?: DepositArchivePoller;
	private accountBalanceArchivePoller?: AccountBalanceArchivePoller;
	private userAssetArchivePoller?: UserAssetArchivePoller;
	private balanceUpdateArchiveConsumer?: BalanceUpdateArchiveConsumer;
	private userDataStreamSupervisor?: UserDataStreamSupervisor;
	private publicMarketDataFeedSupervisor?: PublicMarketDataFeedSupervisor;

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
		this.brokerArchiver = createBrokerExecutionArchiverFromEnv(
			this.otelLogs,
			this.otelMetrics,
		);
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
		if (this.depositReconciler) {
			this.depositReconciler.stop();
			this.depositReconciler = undefined;
		}
		if (this.fillArchivePoller) {
			this.fillArchivePoller.stop();
			this.fillArchivePoller = undefined;
		}
		if (this.depositArchivePoller) {
			await this.depositArchivePoller.stop();
			this.depositArchivePoller = undefined;
		}
		if (this.accountBalanceArchivePoller) {
			await this.accountBalanceArchivePoller.stop();
			this.accountBalanceArchivePoller = undefined;
		}
		if (this.userAssetArchivePoller) {
			await this.userAssetArchivePoller.stop();
			this.userAssetArchivePoller = undefined;
		}
		if (this.balanceUpdateArchiveConsumer) {
			await this.balanceUpdateArchiveConsumer.stop();
			this.balanceUpdateArchiveConsumer = undefined;
		}
		if (this.server) {
			await this.server.forceShutdown();
		}
		if (this.publicMarketDataFeedSupervisor) {
			await this.publicMarketDataFeedSupervisor.close();
			this.publicMarketDataFeedSupervisor = undefined;
		}
		if (this.userDataStreamSupervisor) {
			await this.userDataStreamSupervisor.close();
			this.userDataStreamSupervisor = undefined;
		}
		if (this.brokerArchiver) {
			await this.brokerArchiver.close();
		}
		await Promise.all([this.otelMetrics?.close(), this.otelLogs?.close()]);
	}

	/**
	 * Starts the broker, applying policies then running appropriate tasks.
	 */
	public async run(): Promise<CEXBroker> {
		const marketArchiveState = resolveMarketCaptureArchiveState({
			archiveEnabled: this.brokerArchiver?.isEnabled() ?? false,
			marketArchiveEnabled: isMarketArchiveEnabled(),
			environment: process.env.CEX_BROKER_MARKET_CAPTURE_ENVIRONMENT,
			deploymentId: this.brokerArchiver?.getDeploymentId(),
			captureBundleId: process.env.CEX_BROKER_CAPTURE_BUNDLE_ID,
		});
		assertMarketCaptureArchiveStartable(marketArchiveState);
		if (this.server) {
			await this.server.forceShutdown();
		}
		if (this.publicMarketDataFeedSupervisor) {
			await this.publicMarketDataFeedSupervisor.close();
			this.publicMarketDataFeedSupervisor = undefined;
		}
		// run() is re-invoked on policy hot-reload; tear down the prior reconciler and
		// poller so they are rebuilt rather than duplicated.
		if (this.depositReconciler) {
			this.depositReconciler.stop();
			this.depositReconciler = undefined;
		}
		if (this.fillArchivePoller) {
			this.fillArchivePoller.stop();
			this.fillArchivePoller = undefined;
		}
		if (this.depositArchivePoller) {
			await this.depositArchivePoller.stop();
			this.depositArchivePoller = undefined;
		}
		if (this.accountBalanceArchivePoller) {
			await this.accountBalanceArchivePoller.stop();
			this.accountBalanceArchivePoller = undefined;
		}
		if (this.userAssetArchivePoller) {
			await this.userAssetArchivePoller.stop();
			this.userAssetArchivePoller = undefined;
		}
		if (this.balanceUpdateArchiveConsumer) {
			await this.balanceUpdateArchiveConsumer.stop();
			this.balanceUpdateArchiveConsumer = undefined;
		}
		log.info(`Running CEXBroker at ${new Date().toISOString()}`);

		// Initialize OTel metrics if enabled
		if (this.otelMetrics?.isOtelEnabled()) {
			await this.otelMetrics.initialize();
		}
		if (
			!this.userDataStreamSupervisor &&
			Object.keys(this.brokers).length > 0
		) {
			const publisher = new StreamHealthPublisher(
				streamHealthPublisherConfigFromEnv(),
			);
			this.userDataStreamSupervisor = new UserDataStreamSupervisor({
				brokers: this.brokers,
				publisher,
			});
			this.userDataStreamSupervisor.start();
		}
		this.publicMarketDataFeedSupervisor = new PublicMarketDataFeedSupervisor({
			brokers: this.brokers,
			brokerArchiver: this.brokerArchiver,
			otelMetrics: this.otelMetrics,
		});

		this.server = getServer(
			this.policy,
			this.brokers,
			this.whitelistIps,
			this.useVerity,
			this.#verityProverUrl,
			this.otelMetrics,
			this.brokerArchiver,
			this.orderActivityTracker,
			this.withdrawalObservationTracker,
			undefined,
			this.userDataStreamSupervisor,
			this.publicMarketDataFeedSupervisor,
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

		// Start the travel-rule deposit auto-clear reconciler. It self-disables when
		// no exchange has `travelRule.rule[].deposits.enabled` in policy, so this is a
		// no-op (exact current behavior) unless the feature is turned on.
		this.depositReconciler = new TravelRuleDepositReconciler({
			policy: this.policy,
			brokers: this.brokers,
			config: loadTravelRuleDepositReconcilerConfigFromEnv(process.env),
			metrics: this.otelMetrics,
		});
		this.depositReconciler.start();

		// Fill capture starts only after the archive configuration has passed its
		// forwarder and durable loss-journal validation.
		if (this.brokerArchiver?.isEnabled()) {
			this.fillArchivePoller = new FillArchivePoller({
				brokers: this.brokers,
				archiver: this.brokerArchiver,
				tracker: this.orderActivityTracker,
				metrics: this.otelMetrics,
			});
			this.fillArchivePoller.start();

			this.depositArchivePoller = new DepositArchivePoller({
				brokers: this.brokers,
				archiver: this.brokerArchiver,
				metrics: this.otelMetrics,
			});
			this.depositArchivePoller.start();

			if (this.userDataStreamSupervisor) {
				this.balanceUpdateArchiveConsumer = new BalanceUpdateArchiveConsumer({
					brokers: this.brokers,
					archiver: this.brokerArchiver,
					userDataStreamSupervisor: this.userDataStreamSupervisor,
				});
				this.balanceUpdateArchiveConsumer.start();
			}
		}

		if (this.brokerArchiver?.canPersistAccountBalanceSnapshots()) {
			// Balance coverage is advertised only with the HTTP forwarder: OTel logs
			// are an observability mirror, not durable replay evidence.
			this.accountBalanceArchivePoller = new AccountBalanceArchivePoller({
				brokers: this.brokers,
				archiver: this.brokerArchiver,
				metrics: this.otelMetrics,
			});
			this.accountBalanceArchivePoller.start();

			// Same durability gate and cadence family, separate poller: the sapi
			// user-asset read is the only source for travel-rule-frozen funds, and
			// must not share a failure with the spot balance snapshot.
			this.userAssetArchivePoller = new UserAssetArchivePoller({
				brokers: this.brokers,
				archiver: this.brokerArchiver,
				metrics: this.otelMetrics,
			});
			this.userAssetArchivePoller.start();
		}
		return this;
	}
}
