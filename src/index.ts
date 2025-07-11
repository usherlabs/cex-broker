import ccxt, { type Exchange } from "ccxt";
import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "../proto/node";
import {
	loadPolicy,
	validateOrder,
	validateWithdraw,
	validateDeposit,
	isIpAllowed,
} from "../helpers";
import type { BalanceRequest } from "../proto/cexBroker/BalanceRequest";
import type { BalanceResponse } from "../proto/cexBroker/BalanceResponse";
import {
	BrokerList,
	type BrokerCredentials,
	type ExchangeCredentials,
	type PolicyConfig,
} from "../types";
import type { TransferRequest } from "../proto/cexBroker/TransferRequest";
import type { TransferResponse } from "../proto/cexBroker/TransferResponse";
import type { DepositConfirmationRequest } from "../proto/cexBroker/DepositConfirmationRequest";
import type { DepositConfirmationResponse } from "../proto/cexBroker/DepositConfirmationResponse";
import type { ConvertRequest } from "../proto/cexBroker/ConvertRequest";
import type { ConvertResponse } from "../proto/cexBroker/ConvertResponse";
import type { OrderDetailsRequest } from "../proto/cexBroker/OrderDetailsRequest";
import type { OrderDetailsResponse } from "../proto/cexBroker/OrderDetailsResponse";
import type { CancelOrderRequest } from "../proto/cexBroker/CancelOrderRequest";
import type { CancelOrderResponse } from "../proto/cexBroker/CancelOrderResponse";
import { watchFile, unwatchFile } from "fs";
import Joi from "joi";

const PROTO_FILE = "../proto/node.proto";

const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE));
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;
const fietCexNode = grpcObj.cexBroker;

console.log("CCXT Version:", ccxt.version);

export default class CEXBroker {
	#brokerConfig: Record<string, BrokerCredentials> = {};
	#policyFilePath?: string;
	port = 8086;
	private policy: PolicyConfig;
	private brokers: Record<string, Exchange> = {};
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
		config?: { port: number },
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
		this.server = getServer(this.policy, this.brokers);

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

function authenticateRequest<T, E>(call: grpc.ServerUnaryCall<T, E>): boolean {
	const clientIp = call.getPeer().split(":")[0];
	if (!clientIp || !isIpAllowed(clientIp)) {
		console.warn(
			`Blocked access from unauthorized IP: ${clientIp || "unknown"}`,
		);
		return false;
	}
	return true;
}

function getServer(policy: PolicyConfig, brokers: Record<string, Exchange>) {
	const server = new grpc.Server();
	server.addService(fietCexNode.CexService.service, {
		// TODO: Consolidate all of these calls into "ExecuteAction", "SubscribeToStream"...
		Deposit: async (
			call: grpc.ServerUnaryCall<
				DepositConfirmationRequest,
				DepositConfirmationResponse
			>,
			callback: grpc.sendUnaryData<DepositConfirmationResponse>,
		) => {
			// IP Authentication
			if (!authenticateRequest(call)) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
			}

			// Implement deposit logic
			const { chain, recipientAddress, amount, transactionHash } = call.request;

			// Validate required fields
			if (!chain || !amount || !recipientAddress || !transactionHash) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message:
							"chain, transactionHash, recipientAddress and amount are required",
					},
					null,
				);
			}

			// Validate against policy

			// TODO: I recognise that deposit/withdraw, etc. will need additional considerations as we validate against the policy...
			// TODO: Therefore, either we can keep the standalone Deposit/Withdraw Methods, or we check the "ExecuteAction" method for the "deposit"/"withdraw"/"convert"/"cancelOrder"/"getOrderDetails"/"getBalance" actions... to determine extra validation.
			const validation = validateDeposit(policy, chain, Number(amount));
			if (!validation.valid) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: validation.error,
					},
					null,
				);
			}

			// TODO: Where is CCXT used here?
			try {
				console.log(
					`[${new Date().toISOString()}] ` +
						`Amount ${amount} at ${transactionHash} on chain ${chain}. Paid to ${recipientAddress}`,
				);
				callback(null, { newBalance: 0 });
			} catch (error) {
				console.error({ error });
				callback(
					{
						code: grpc.status.INTERNAL,
						message: "Deposit confirmation failed",
					},
					null,
				);
			}
		},
		Transfer: async (
			call: grpc.ServerUnaryCall<TransferRequest, TransferResponse>,
			callback: grpc.sendUnaryData<TransferResponse>,
		) => {
			// IP Authentication
			if (!authenticateRequest(call)) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
			}

			// Implement transfer logic
			const { chain, cex, amount, recipientAddress, token } = call.request;

			// Validate required fields
			if (!chain || !recipientAddress || !amount || !cex || !token) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message:
							"chain, recipient_address, amount, and ticker are required",
					},
					null,
				);
			}

			// Validate against policy
			const validation = validateWithdraw(
				policy,
				chain,
				recipientAddress,
				Number(amount),
				token,
			);
			if (!validation.valid) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: validation.error,
					},
					null,
				);
			}

			try {
				if (!Object.keys(brokers).includes(cex)) {
					return callback(
						{
							code: grpc.status.INTERNAL,
							message: `Broker ${cex} is not active. Allowed Broker: ${Object.keys(brokers).join(", ")}`,
						},
						null,
					);
				}

				// Validate CEX key
				const broker = brokers[cex as keyof typeof brokers];
				if (!broker) {
					return callback(
						{
							code: grpc.status.INVALID_ARGUMENT,
							message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
						},
						null,
					);
				}

				const data = await broker.fetchCurrencies("USDT");
				const networks = Object.keys(
					(data[token] ?? { networks: [] }).networks,
				);

				if (!networks.includes(chain)) {
					return callback(
						{
							code: grpc.status.INTERNAL,
							message: `Broker ${cex} doesnt support this ${chain} for token ${token}`,
						},
						null,
					);
				}

				// TODO: My point is why can this not be agnostic to the CEX...
				const transaction = await broker.withdraw(
					token,
					Number(amount),
					recipientAddress,
					undefined,
					{ network: chain },
				);

				callback(null, { success: true, transactionId: transaction.id });
			} catch (error) {
				console.error({ error });
				callback(
					{
						code: grpc.status.INTERNAL,
						message: "Transfer failed",
					},
					null,
				);
			}
		},

		// TODO: "Convert" and "createLimitOrder" are too extremely different things...
		// TODO: "Convert" is a generic action that can be used to convert any token to any other token...
		// TODO: "createLimitOrder" is a specific action that can be used to create a limit order on a specific CEX...
		// TODO: "Convert" could be "createMarketOrder"... a differnt thing to "createLimitOrder"...
		Convert: async (
			call: grpc.ServerUnaryCall<ConvertRequest, ConvertResponse>,
			callback: grpc.sendUnaryData<ConvertResponse>,
		) => {
			// IP Authentication
			if (!authenticateRequest(call)) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
			}

			// Implement convert logic
			const { fromToken, toToken, amount, cex, price } = call.request;

			// Validate required fields
			if (!fromToken || !toToken || !amount || !cex || !price) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "toToken, fromToken, amount, cex, and price are required",
					},
					null,
				);
			}

			const validation = validateOrder(
				policy,
				fromToken,
				toToken,
				Number(amount),
				cex,
			);
			if (!validation.valid) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: validation.error,
					},
					null,
				);
			}

			try {
				// Validate CEX key
				const broker = brokers[cex as keyof typeof brokers];

				const market = policy.order.rule.markets.find(
					(market) =>
						market.includes(`${fromToken}/${toToken}`) ||
						market.includes(`${toToken}/${fromToken}`),
				);
				const symbol = market?.split(":")[1] ?? "";
				const [from, _to] = symbol.split("/");

				if (!broker) {
					return callback(
						{
							code: grpc.status.INVALID_ARGUMENT,
							message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
						},
						null,
					);
				}

				const order = await broker.createLimitOrder(
					symbol,
					from === fromToken ? "sell" : "buy",
					Number(amount),
					Number(price),
				);

				callback(null, {
					orderId: order.id,
				});
			} catch (error) {
				console.error({ error });
				callback(
					{
						code: grpc.status.INTERNAL,
						message: "Conversion failed",
					},
					null,
				);
			}
		},
		GetBalance: async (
			call: grpc.ServerUnaryCall<BalanceRequest, BalanceResponse>,
			callback: grpc.sendUnaryData<BalanceResponse>,
		) => {
			// IP Authentication
			if (!authenticateRequest(call)) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
			}

			const { cex, token } = call.request as Required<BalanceRequest>;

			// Validate required fields
			if (!cex) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "cex_key is required",
					},
					null,
				);
			}

			if (!token) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "token is required",
					},
					null,
				);
			}

			// Validate CEX key
			const broker = brokers[cex as keyof typeof brokers];
			if (!broker) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
					},
					null,
				);
			}

			try {
				// Fetch balance from the specified CEX
				const balance = (await broker.fetchFreeBalance()) as any;
				const currencyBalance = balance[token];

				callback(null, {
					balance: currencyBalance || 0,
					currency: token,
				});
			} catch (error) {
				console.error(`Error fetching balance from ${cex}:`, error);
				callback(
					{
						code: grpc.status.INTERNAL,
						message: `Failed to fetch balance from ${cex}`,
					},
					null,
				);
			}
		},
		GetOrderDetails: async (
			call: grpc.ServerUnaryCall<OrderDetailsRequest, OrderDetailsResponse>,
			callback: grpc.sendUnaryData<OrderDetailsResponse>,
		) => {
			// IP Authentication
			if (!authenticateRequest(call)) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
			}

			const { orderId, cex } = call.request;

			// Validate required fields
			if (!orderId || !cex) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "order_id and cex are required",
					},
					null,
				);
			}

			try {
				// Validate CEX key
				const broker = brokers[cex as keyof typeof brokers];
				if (!broker) {
					return callback(
						{
							code: grpc.status.INVALID_ARGUMENT,
							message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
						},
						null,
					);
				}

				const orderDetails = await broker.fetchOrder(orderId);

				callback(null, {
					orderId: orderDetails.id,
					status: orderDetails.status,
					originalAmount: orderDetails.amount,
					filledAmount: orderDetails.filled,
					symbol: orderDetails.symbol,
					mode: orderDetails.side,
					price: orderDetails.price,
				});
			} catch (error) {
				console.error(`Error fetching order details from ${cex}:`, error);
				callback(
					{
						code: grpc.status.INTERNAL,
						message: `Failed to fetch order details from ${cex}`,
					},
					null,
				);
			}
		},
		CancelOrder: async (
			call: grpc.ServerUnaryCall<CancelOrderRequest, CancelOrderResponse>,
			callback: grpc.sendUnaryData<CancelOrderResponse>,
		) => {
			// IP Authentication
			if (!authenticateRequest(call)) {
				return callback(
					{
						code: grpc.status.PERMISSION_DENIED,
						message: "Access denied: Unauthorized IP",
					},
					null,
				);
			}

			const { orderId, cex } = call.request;

			// Validate required fields
			if (!orderId || !cex) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "order_id and cex are required",
					},
					null,
				);
			}

			try {
				// Validate CEX key
				const broker = brokers[cex as keyof typeof brokers];
				if (!broker) {
					return callback(
						{
							code: grpc.status.INVALID_ARGUMENT,
							message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
						},
						null,
					);
				}

				const cancelledOrder: any = await broker.cancelOrder(orderId);

				callback(null, {
					success: cancelledOrder.status === "canceled",
					finalStatus: cancelledOrder.status,
				});
			} catch (error) {
				console.error(`Error cancelling order from ${cex}:`, error);
				callback(
					{
						code: grpc.status.INTERNAL,
						message: `Failed to cancel order from ${cex}`,
					},
					null,
				);
			}
		},
	});
	return server;
}
