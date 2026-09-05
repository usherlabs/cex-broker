import type { Metadata } from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import type { BrokerAccount } from "./broker";
import { getCurrentBrokerSelector } from "./broker";
import {
	redactSecretLiterals,
	removeSecretMaterial,
} from "./broker-execution-archive/redact";
import { sha256Canonical } from "./market-data-archive/capture-contract";
import { sanitizeErrorDetail } from "./shared/errors";
import { isRecord } from "./shared/guards";

const DECIMAL_PATTERN = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export type EvidenceAccountScope = {
	accountSelector: string;
	credentialSource: "configured_pool" | "request_metadata";
};

export type SpotMarketIdentity = {
	market: Record<string, unknown>;
	canonicalPair: string;
	unifiedSymbol: string;
	sourceSymbol: string;
	baseAsset: string;
	quoteAsset: string;
};

type ExchangeWithEvidence = Exchange & {
	has?: Record<string, unknown>;
	precisionMode?: number | string;
	markets?: Record<string, unknown>;
	fetchTradingFee?: (
		symbol: string,
		params?: Record<string, unknown>,
	) => Promise<unknown>;
};

export function exchangeSecretLiterals(broker: Exchange): string[] {
	// SAFETY: CCXT exchange credential properties are runtime-defined.
	const record = broker as unknown as Record<string, unknown>;
	return [
		record.apiKey,
		record.secret,
		record.password,
		record.privateKey,
	].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
}

export function sanitizeVenueError(error: unknown, broker: Exchange): string {
	return redactSecretLiterals(
		sanitizeErrorDetail(error),
		exchangeSecretLiterals(broker),
	);
}

export function resolveEvidenceAccountScope(
	selectedBrokerAccount: BrokerAccount | undefined,
	metadata: Metadata,
): EvidenceAccountScope {
	return {
		accountSelector:
			selectedBrokerAccount?.label ?? getCurrentBrokerSelector(metadata),
		credentialSource: selectedBrokerAccount
			? "configured_pool"
			: "request_metadata",
	};
}

export function canonicalNonnegativeDecimal(
	value: unknown,
	field: string,
): string {
	const text =
		typeof value === "number"
			? Number.isFinite(value)
				? String(value)
				: ""
			: typeof value === "string"
				? value.trim()
				: "";
	const match = text.match(DECIMAL_PATTERN);
	if (!match) {
		throw new Error(`venue_discovery_unavailable: ${field} must be decimal`);
	}
	const integer = match[1] ?? "0";
	const fraction = match[2] ?? "";
	const exponent = Number.parseInt(match[3] ?? "0", 10);
	if (!Number.isSafeInteger(exponent)) {
		throw new Error(
			`venue_discovery_unavailable: ${field} exponent is invalid`,
		);
	}
	const digits = `${integer}${fraction}`;
	const decimalIndex = integer.length + exponent;
	let rendered: string;
	if (decimalIndex <= 0) {
		rendered = `0.${"0".repeat(-decimalIndex)}${digits}`;
	} else if (decimalIndex >= digits.length) {
		rendered = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
	} else {
		rendered = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
	}
	const [whole = "0", decimals = ""] = rendered.split(".");
	const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
	const normalizedDecimals = decimals.replace(/0+$/, "");
	return normalizedDecimals
		? `${normalizedWhole}.${normalizedDecimals}`
		: normalizedWhole;
}

export function decimalFractionToBasisPoints(value: unknown): string {
	const canonical = canonicalNonnegativeDecimal(value, "fee rate");
	return canonicalNonnegativeDecimal(`${canonical}e4`, "fee basis points");
}

export function canonicalOptionalDecimal(
	value: unknown,
	field: string,
): string | undefined {
	return value === undefined || value === null
		? undefined
		: canonicalNonnegativeDecimal(value, field);
}

export function precisionIncrement(
	value: unknown,
	precisionMode: unknown,
	field: string,
): string {
	if (
		(precisionMode === 2 || precisionMode === "DECIMAL_PLACES") &&
		(typeof value === "number" || typeof value === "string")
	) {
		const decimalPlaces = Number(value);
		if (Number.isInteger(decimalPlaces) && decimalPlaces >= 0) {
			return canonicalNonnegativeDecimal(`1e-${decimalPlaces}`, field);
		}
	}
	return canonicalNonnegativeDecimal(value, field);
}

export function evidenceSourceDigest(input: {
	action: string;
	exchange: string;
	requestedKey: string;
	accountSelector: string;
	sourceMethod: string;
	source: unknown;
	broker: Exchange;
}): string {
	const source = removeSecretMaterial(
		input.source,
		exchangeSecretLiterals(input.broker),
	);
	return sha256Canonical({
		action: input.action,
		exchange: input.exchange,
		requestedKey: input.requestedKey,
		accountSelector: input.accountSelector,
		sourceMethod: input.sourceMethod,
		source,
	});
}

export async function resolveSpotMarketIdentity(
	broker: Exchange,
	symbol: string,
): Promise<SpotMarketIdentity> {
	const requestedSymbol = symbol.trim().toUpperCase();
	if (!/^[^/\s]+\/[^/\s]+$/.test(requestedSymbol)) {
		throw new Error(
			"venue_discovery_unavailable: symbol must be a slash-delimited spot pair",
		);
	}
	await broker.loadMarkets();
	const market = broker.market(requestedSymbol) as unknown;
	if (!isRecord(market)) {
		throw new Error(
			`venue_discovery_unavailable: market not found for ${requestedSymbol}`,
		);
	}
	const unifiedSymbol =
		typeof market.symbol === "string"
			? market.symbol.trim().toUpperCase()
			: requestedSymbol;
	const baseAsset =
		typeof market.base === "string" ? market.base.trim().toUpperCase() : "";
	const quoteAsset =
		typeof market.quote === "string" ? market.quote.trim().toUpperCase() : "";
	const sourceSymbol = typeof market.id === "string" ? market.id.trim() : "";
	const isSpot = market.spot === true || market.type === "spot";
	if (
		unifiedSymbol !== requestedSymbol ||
		!baseAsset ||
		!quoteAsset ||
		!sourceSymbol ||
		!isSpot ||
		market.active !== true
	) {
		throw new Error(
			`venue_discovery_unavailable: active spot market identity unavailable for ${requestedSymbol}`,
		);
	}
	return {
		market,
		canonicalPair: `${baseAsset}-${quoteAsset}`,
		unifiedSymbol,
		sourceSymbol,
		baseAsset,
		quoteAsset,
	};
}

export function extractTradingFeeRates(response: unknown): {
	makerRate: string;
	takerRate: string;
} {
	if (!isRecord(response)) {
		throw new Error("fee_unavailable: trading-fee response is not an object");
	}
	const info = isRecord(response.info) ? response.info : undefined;
	const nestedData = isRecord(info?.data)
		? info.data
		: isRecord(response.data)
			? response.data
			: undefined;
	const maker = [
		response.maker,
		response.makerCommission,
		nestedData?.maker,
		nestedData?.makerCommission,
	].find((value) => value !== undefined && value !== null);
	const taker = [
		response.taker,
		response.takerCommission,
		nestedData?.taker,
		nestedData?.takerCommission,
	].find((value) => value !== undefined && value !== null);
	try {
		return {
			makerRate: canonicalNonnegativeDecimal(maker, "maker commission"),
			takerRate: canonicalNonnegativeDecimal(taker, "taker commission"),
		};
	} catch (error) {
		throw new Error(`fee_unavailable: ${sanitizeErrorDetail(error)}`, {
			cause: error,
		});
	}
}

export function evidenceExchange(broker: Exchange): ExchangeWithEvidence {
	return broker as ExchangeWithEvidence;
}
