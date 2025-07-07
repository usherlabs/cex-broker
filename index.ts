import ccxt from "ccxt";
import path from "bun:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "./proto/node";
import config from "./config";
import brokers from "./config/broker";
import type { OptimalPriceRequest } from "./proto/fietCexNode/OptimalPriceRequest";
import {
	buyAtOptimalPrice,
	sellAtOptimalPrice,
	loadPolicy,
	validateOrder,
	validateWithdraw,
	validateDeposit,
	isIpAllowed,
} from "./helpers";
import type { OptimalPriceResponse } from "./proto/fietCexNode/OptimalPriceResponse";
import type { BalanceRequest } from "./proto/fietCexNode/BalanceRequest";
import type { BalanceResponse } from "./proto/fietCexNode/BalanceResponse";
import type { PolicyConfig } from "./types";
import type { TransferRequest } from "./proto/fietCexNode/TransferRequest";
import type { TransferResponse } from "./proto/fietCexNode/TransferResponse";
import type { DepositConfirmationRequest } from "./proto/fietCexNode/DepositConfirmationRequest";
import type { DepositConfirmationResponse } from "./proto/fietCexNode/DepositConfirmationResponse";
import type { ConvertRequest } from "./proto/fietCexNode/ConvertRequest";
import type { ConvertResponse } from "./proto/fietCexNode/ConvertResponse";
import type { OrderDetailsRequest } from "./proto/fietCexNode/OrderDetailsRequest";
import type { OrderDetailsResponse } from "./proto/fietCexNode/OrderDetailsResponse";
import type { CancelOrderRequest } from "./proto/fietCexNode/CancelOrderRequest";
import type { CancelOrderResponse } from "./proto/fietCexNode/CancelOrderResponse";

const PROTO_FILE = "./proto/node.proto";

const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE));
const grpcObj = grpc.loadPackageDefinition(
	packageDef,
) as unknown as ProtoGrpcType;
const fietCexNode = grpcObj.fietCexNode;

console.log("CCXT Version:", ccxt.version);

async function main() {
	// Load policy configuration
	const policy = loadPolicy();
	console.log("Policy loaded successfully");

	const server = getServer(policy);

	// TODO: Remove this...
	console.log(
		`BINANCE: Broker Balance ,${JSON.stringify(await brokers.BINANCE.fetchFreeBalance())}`,
	);
	console.log(
		`BYBIT: Broker Balance ,${JSON.stringify(await brokers.BYBIT.fetchFreeBalance())}`,
	);

	server.bindAsync(
		`0.0.0.0:${config.port}`,
		grpc.ServerCredentials.createInsecure(),
		(err, port) => {
			if (err) {
				console.error(err);
				return;
			}
			console.log(`Your server as started on port ${port}`);
		},
	);
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

function getServer(policy: PolicyConfig) {
	const server = new grpc.Server();
	server.addService(fietCexNode.CexService.service, {
		// TODO: Consolidate all of these calls into "ExecuteAction", "SubscribeToStream"...

		// TODO: Getting optimal price is for the MM tech to decide...
		GetOptimalPrice: async (
			call: grpc.ServerUnaryCall<OptimalPriceRequest, OptimalPriceResponse>,
			callback: grpc.sendUnaryData<OptimalPriceResponse>,
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

			const { mode, symbol, quantity } =
				call.request as Required<OptimalPriceRequest>;

			// Validate required fields
			if (mode === undefined || mode === null) {
				// Return a gRPC error
				const error = {
					code: grpc.status.INVALID_ARGUMENT,
					message: "Mode is required and must be BUY or SELL",
				};
				return callback(error, null);
			}

			if (!symbol) {
				const error = {
					code: grpc.status.INVALID_ARGUMENT,
					message: "Symbol is required",
				};
				return callback(error, null);
			}

			if (!quantity || Number(quantity) <= 0) {
				const error = {
					code: grpc.status.INVALID_ARGUMENT,
					message: "Quantity must be a positive number",
				};
				return callback(error, null);
			}
			// Extract tokens from symbol (e.g., "ARB/USDT" -> fromToken: "ARB", toToken: "USDT")
			const tokens = symbol.split("/");
			if (tokens.length !== 2) {
				return callback(
					{
						code: grpc.status.INVALID_ARGUMENT,
						message: "Invalid symbol format. Expected format: TOKEN1/TOKEN2",
					},
					null,
				);
			}

			if (mode === 1) {
				const BINANCE = await sellAtOptimalPrice(
					brokers.BINANCE,
					symbol,
					Number(quantity),
				);
				const BYBIT = await sellAtOptimalPrice(
					brokers.BYBIT,
					symbol,
					Number(quantity),
				);
				return callback(null, { results: { BINANCE, BYBIT } });
			} else {
				const BINANCE = await buyAtOptimalPrice(
					brokers.BINANCE,
					symbol,
					Number(quantity),
				);
				const BYBIT = await buyAtOptimalPrice(
					brokers.BYBIT,
					symbol,
					Number(quantity),
				);
				return callback(null, { results: { BINANCE, BYBIT } });
			}
		},
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

				const cancelledOrder = await broker.cancelOrder(orderId);

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

main();
