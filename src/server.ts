import {
    validateDeposit,
    validateOrder,
    validateWithdraw,
} from "./helpers";
import type { PolicyConfig } from "../types";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ProtoGrpcType } from "../proto/node";
import path from "path";
import type { Exchange } from "ccxt";
import type { CcxtActionRequest, CcxtActionRequest__Output } from "../proto/cexBroker/CcxtActionRequest";
import type { CcxtActionResponse } from "../proto/cexBroker/CcxtActionResponse";
import { Action } from "../proto/cexBroker/Action";
import Joi from "joi";
import ccxt from "ccxt";
import { log } from "./helpers/logger";


const PROTO_FILE = "../proto/node.proto";

const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE));
const grpcObj = grpc.loadPackageDefinition(
    packageDef,
) as unknown as ProtoGrpcType;
const cexNode = grpcObj.cexBroker;

function authenticateRequest<T, E>(call: grpc.ServerUnaryCall<T, E>, whitelistIps: string[]): boolean {
    const clientIp = call.getPeer().split(":")[0];
    if (!clientIp || !whitelistIps.includes(clientIp)) {
        console.warn(
            `Blocked access from unauthorized IP: ${clientIp || "unknown"}`,
        );
        return false;
    }
    return true;
}

function createBroker(cex: string, metadata: grpc.Metadata): Exchange |null{
    const api_key = metadata.get('api-key');
    const api_secret = metadata.get('api-secret');
    const ExchangeClass = (ccxt as any)[cex];

    metadata.remove('api-key');
    metadata.remove('api-secret');
    if (api_secret.length==0 || api_key.length==0){
        return null
    }
    return new ExchangeClass({
        apiKey: api_key[0],
        secret: api_secret[0],
        enableRateLimit: true,
        defaultType: "spot",
    });
}


export function getServer(policy: PolicyConfig, brokers: Record<string, Exchange>, whitelistIps: string[]) {
    const server = new grpc.Server();
    server.addService(cexNode.CexService.service, {
        ExecuteCcxtAction: async (
            call: grpc.ServerUnaryCall<
                CcxtActionRequest,
                CcxtActionResponse
            >,
            callback: grpc.sendUnaryData<CcxtActionResponse>,
        ) => {
            // IP Authentication
            if (!authenticateRequest(call, whitelistIps)) {
                return callback(
                    {
                        code: grpc.status.PERMISSION_DENIED,
                        message: "Access denied: Unauthorized IP",
                    },
                    null,
                );
            }
            // Read incoming metadata
            const metadata = call.metadata;
            const { action, payload, cex, symbol } = call.request
            // Validate required fields
            if (!action || !cex || !symbol ) {
                return callback(
                    {
                        code: grpc.status.INVALID_ARGUMENT,
                        message:
                            "action, cex, symbol, and cex are required",
                    },
                    null,
                );
            }



            const broker = brokers[cex as keyof typeof brokers]
                ?? createBroker(cex, metadata);

            if(!broker){
                return callback(
                    {
                        code: grpc.status.UNAUTHENTICATED,
                        message: `This Exchange is not registered and No API metadata ws found`,
                    },
                    null,
                );
            }

            switch (action) {
                case Action.Deposit:
                    const transactionSchema = Joi.object({
                        recipientAddress: Joi.string()
                            .required(),
                        amount: Joi.number().positive().required(),     // Must be a positive number
                        transactionHash: Joi.string().required()
                    });
                    const { value, error } = transactionSchema.validate(call.request.payload)
                    if (error) {
                        return callback(
                            {
                                code: grpc.status.INVALID_ARGUMENT,
                                message:
                                    "ValidationError:" + error.message,
                            },
                            null,
                        );
                    }
                    try {
                        const deposits = await broker.fetchDeposits(symbol, 50)
                        const deposit = deposits.find(deposit => deposit.id == value.transactionHash || deposit.txid == value.transactionHash)

                        if (deposit) {
                            log.info(
                                `[${new Date().toISOString()}] ` +
                                `Amount ${value.amount} at ${value.transactionHash} . Paid to ${value.recipientAddress}`,
                            );
                            deposit.network
                            return callback(null, { result: JSON.stringify({ ...deposit }) });
                        }
                        callback(
                            {
                                code: grpc.status.INTERNAL,
                                message: "Deposit confirmation failed",
                            },
                            null,
                        );
                    } catch (error) {
                        log.error({ error });
                        callback(
                            {
                                code: grpc.status.INTERNAL,
                                message: "Deposit confirmation failed",
                            },
                            null,
                        );
                    }
                    break;

                case Action.Transfer:
                    const transferSchema = Joi.object({
                        recipientAddress: Joi.string()
                            .required(),
                        amount: Joi.number().positive().required(),     // Must be a positive number
                        chain: Joi.string().required()
                    });
                    const { value: transferValue, error: transferError } = transferSchema.validate(call.request.payload)
                    if (transferError) {
                        return callback(
                            {
                                code: grpc.status.INVALID_ARGUMENT,
                                message:
                                    "ValidationError:" + transferError.message,
                            },
                            null,
                        );
                    }
                    // Validate against policy
                    const transferValidation = validateWithdraw(
                        policy,
                        transferValue.chain,
                        transferValue.recipientAddress,
                        Number(transferValue.amount),
                        symbol,
                    );
                    if (!transferValidation.valid) {
                        return callback(
                            {
                                code: grpc.status.PERMISSION_DENIED,
                                message: transferValidation.error,
                            },
                            null,
                        );
                    }
                    try {
                        const data = await broker.fetchCurrencies("USDT");
                        const networks = Object.keys(
                            (data[symbol] ?? { networks: [] }).networks,
                        );

                        if (!networks.includes(transferValue.chain)) {
                            return callback(
                                {
                                    code: grpc.status.INTERNAL,
                                    message: `Broker ${cex} doesnt support this ${transferValue.chain} for token ${symbol}`,
                                },
                                null,
                            );
                        }
                        const transaction = await broker.withdraw(
                            symbol,
                            Number(transferValue.amount),
                            transferValue.recipientAddress,
                            undefined,
                            { network: transferValue.chain },
                        );

                        callback(null, { result: JSON.stringify({ ...transaction }) });
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
                    break;

                case Action.CreateOrder:
                    const createOrderSchema = Joi.object({
                        amount: Joi.number().positive().required(),     // Must be a positive number
                        fromToken: Joi.string().required(),
                        toToken: Joi.string().required(),
                        price: Joi.number().positive().required()
                    });
                    const { value: orderValue, error: orderError } = createOrderSchema.validate(call.request.payload)
                    if (orderError) {
                        return callback(
                            {
                                code: grpc.status.INVALID_ARGUMENT,
                                message:
                                    "ValidationError:" + orderError.message,
                            },
                            null,
                        );
                    }
                    const validation = validateOrder(
                        policy,
                        orderValue.fromToken,
                        orderValue.toToken,
                        Number(orderValue.amount),
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

                        const market = policy.order.rule.markets.find(
                            (market) =>
                                market.includes(`${orderValue.fromToken}/${orderValue.toToken}`) ||
                                market.includes(`${orderValue.toToken}/${orderValue.fromToken}`),
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
                            from === orderValue.fromToken ? "sell" : "buy",
                            Number(orderValue.amount),
                            Number(orderValue.price),
                        );

                        callback(null, { result: JSON.stringify({ ...order }) });
                    } catch (error) {
                        console.error({ error });
                        callback(
                            {
                                code: grpc.status.INTERNAL,
                                message: "Order Creation failed",
                            },
                            null,
                        );
                    }

                    break;

                case Action.GetOrderDetails:
                    const getOrderSchema = Joi.object({
                        orderId: Joi.string().required(),
                    });
                    const { value: getOrderValue, error: getOrderError } = getOrderSchema.validate(call.request.payload)
                    // Validate required fields
                    if (getOrderError) {
                        return callback(
                            {
                                code: grpc.status.INVALID_ARGUMENT,
                                message:
                                    "ValidationError:" + getOrderError.message,
                            },
                            null,
                        );
                    }

                    try {
                        // Validate CEX key
                        if (!broker) {
                            return callback(
                                {
                                    code: grpc.status.INVALID_ARGUMENT,
                                    message: `Invalid CEX key: ${cex}. Supported keys: ${Object.keys(brokers).join(", ")}`,
                                },
                                null,
                            );
                        }

                        const orderDetails = await broker.fetchOrder(getOrderValue.orderId);

                        callback(null, {
                            result: JSON.stringify({
                                orderId: orderDetails.id,
                                status: orderDetails.status,
                                originalAmount: orderDetails.amount,
                                filledAmount: orderDetails.filled,
                                symbol: orderDetails.symbol,
                                mode: orderDetails.side,
                                price: orderDetails.price,
                            })
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
                    break;
                case Action.CancelOrder:
                    const cancelOrderSchema = Joi.object({
                        orderId: Joi.string().required(),
                    });
                    const { value: cancelOrderValue, error: cancelOrderError } = cancelOrderSchema.validate(call.request.payload)
                    // Validate required fields
                    if (cancelOrderError) {
                        return callback(
                            {
                                code: grpc.status.INVALID_ARGUMENT,
                                message:
                                    "ValidationError:" + cancelOrderError.message,
                            },
                            null,
                        );
                    }

                    const cancelledOrder = await broker.cancelOrder(cancelOrderValue.orderId);

                    callback(null, {
                        result:JSON.stringify({...cancelledOrder})
                    });   
                    break;
                case Action.FetchBalance:
                    try {
                        // Fetch balance from the specified CEX
                        const balance = (await broker.fetchFreeBalance()) as any;
                        const currencyBalance = balance[symbol];
        
                        callback(null, {
                            result: JSON.stringify({
                            balance: currencyBalance || 0,
                            currency: symbol
                        })
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
                    break;

                default:
                    return callback(
                        {
                            code: grpc.status.INVALID_ARGUMENT,
                            message:
                                "Invalid Action",
                        },
                    )
            }
        },
    });
    return server;
}
