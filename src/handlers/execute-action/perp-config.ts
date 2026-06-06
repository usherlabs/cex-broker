import * as grpc from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import { Action } from "../../helpers/constants";
import { getErrorMessage, safeLogError } from "../../helpers/shared/errors";
import {
	GetPerpConfigStatePayloadSchema,
	SetPerpConfigStatePayloadSchema,
} from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction } from "./context";

type ExchangeWithPerpCapabilities = Exchange & {
	has?: Record<string, boolean | string>;
	fetchPositions?: (
		symbols?: string[],
		params?: Record<string, unknown>,
	) => Promise<Record<string, unknown>[]>;
	setLeverage?: (
		leverage: number,
		symbol: string,
		params?: Record<string, unknown>,
	) => Promise<unknown>;
};

function exchangeSupports(
	broker: ExchangeWithPerpCapabilities,
	capability: string,
): boolean {
	return broker.has?.[capability] === true;
}

function extractPerpConfigs(positions: Record<string, unknown>[]): Array<{
	symbol?: string;
	leverage?: number;
	marginMode?: string;
}> {
	return positions.map((position) => ({
		symbol: typeof position.symbol === "string" ? position.symbol : undefined,
		leverage:
			typeof position.leverage === "number" ? position.leverage : undefined,
		marginMode:
			typeof position.marginMode === "string" ? position.marginMode : undefined,
	}));
}

async function handleGetPerpConfigState(
	ctx: ExecuteActionContext,
): Promise<void> {
	const { wrappedCallback, cex, normalizedCex, broker } = ctx;
	const payload = parsePayloadForAction(ctx, GetPerpConfigStatePayloadSchema);
	if (payload === null) {
		return;
	}

	if (!broker) {
		return wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `Invalid CEX key: ${cex}`,
			},
			null,
		);
	}

	const exchange = broker as ExchangeWithPerpCapabilities;
	if (!exchangeSupports(exchange, "fetchPositions")) {
		return wrappedCallback(
			{
				code: grpc.status.UNIMPLEMENTED,
				message: `${normalizedCex} does not support fetchPositions`,
			},
			null,
		);
	}

	try {
		const symbols = payload.symbol ? [payload.symbol] : undefined;
		const positions = (await exchange.fetchPositions?.(
			symbols,
			payload.params,
		)) as unknown as Record<string, unknown>[];
		ctx.wrappedCallback(null, {
			result: JSON.stringify({
				exchange: normalizedCex,
				configs: extractPerpConfigs(positions ?? []),
				positions: positions ?? [],
			}),
		});
	} catch (error) {
		safeLogError(`GetPerpConfigState failed for ${cex}`, error);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: getErrorMessage(error),
			},
			null,
		);
	}
}

async function handleSetPerpConfigState(
	ctx: ExecuteActionContext,
): Promise<void> {
	const { wrappedCallback, cex, normalizedCex, broker } = ctx;
	const payload = parsePayloadForAction(ctx, SetPerpConfigStatePayloadSchema);
	if (payload === null) {
		return;
	}

	if (!broker) {
		return wrappedCallback(
			{
				code: grpc.status.INVALID_ARGUMENT,
				message: `Invalid CEX key: ${cex}`,
			},
			null,
		);
	}

	const exchange = broker as ExchangeWithPerpCapabilities;
	if (!exchangeSupports(exchange, "setLeverage")) {
		return wrappedCallback(
			{
				code: grpc.status.UNIMPLEMENTED,
				message: `${normalizedCex} does not support setLeverage`,
			},
			null,
		);
	}

	try {
		const response = await exchange.setLeverage?.(
			payload.leverage,
			payload.symbol,
			{
				marginMode: payload.marginMode ?? "cross",
				...payload.params,
			},
		);
		ctx.wrappedCallback(null, {
			result: JSON.stringify({
				exchange: normalizedCex,
				symbol: payload.symbol,
				leverage: payload.leverage,
				marginMode: payload.marginMode ?? "cross",
				response,
			}),
		});
	} catch (error) {
		safeLogError(`SetPerpConfigState failed for ${cex}`, error);
		ctx.wrappedCallback(
			{
				code: grpc.status.INTERNAL,
				message: getErrorMessage(error),
			},
			null,
		);
	}
}

export async function handlePerpConfig(
	ctx: ExecuteActionContext,
): Promise<void> {
	if (ctx.action === Action.GetPerpConfigState) {
		return handleGetPerpConfigState(ctx);
	}
	if (ctx.action === Action.SetPerpConfigState) {
		return handleSetPerpConfigState(ctx);
	}
}
