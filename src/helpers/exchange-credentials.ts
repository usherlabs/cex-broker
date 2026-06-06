import type { Exchange } from "@usherlabs/ccxt";
import ccxt from "@usherlabs/ccxt";

export type BrokerKeyPair = {
	apiKey: string;
	apiSecret: string;
};

type RequiredCredentials = Exchange["requiredCredentials"];

const walletBasedCache = new Map<string, boolean>();

function resolveExchangeClass(cex: string): (typeof Exchange) | null {
	const ExchangeClass = (ccxt.pro as Record<string, typeof Exchange>)[cex];
	return ExchangeClass ?? null;
}

export function getExchangeRequiredCredentials(
	cex: string,
): RequiredCredentials | null {
	const ExchangeClass = resolveExchangeClass(cex);
	if (!ExchangeClass) {
		return null;
	}

	const probe = new ExchangeClass({});
	return probe.requiredCredentials;
}

export function isWalletBasedExchange(cex: string): boolean {
	const cached = walletBasedCache.get(cex);
	if (cached !== undefined) {
		return cached;
	}

	const required = getExchangeRequiredCredentials(cex);
	const walletBased =
		required !== null &&
		required.walletAddress === true &&
		required.privateKey === true &&
		required.apiKey !== true &&
		required.secret !== true;

	walletBasedCache.set(cex, walletBased);
	return walletBased;
}

function normalizeHexCredential(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return trimmed;
	}
	if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
		return `0x${trimmed.slice(2)}`;
	}
	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
		return `0x${trimmed}`;
	}
	return trimmed;
}

export function buildCcxtConfig(
	cex: string,
	creds: BrokerKeyPair,
): Record<string, string> | null {
	if (!creds.apiKey || !creds.apiSecret) {
		return null;
	}

	if (isWalletBasedExchange(cex)) {
		return {
			walletAddress: normalizeHexCredential(creds.apiKey),
			privateKey: normalizeHexCredential(creds.apiSecret),
		};
	}

	return {
		apiKey: creds.apiKey,
		secret: creds.apiSecret,
	};
}