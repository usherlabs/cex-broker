import type { Metadata } from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import ccxt from "@usherlabs/ccxt";
import type { BrokerAccountRole, BrokerCredentials } from "../types";
import { buildCcxtConfig } from "./exchange-credentials";
import { log } from "./logger";
import { registerBinanceTravelRuleWithdrawEndpoint } from "./travel-rule";

export type BrokerAccount = {
	exchange: Exchange;
	label: "primary" | `secondary:${number}`;
	index?: number;
	role?: BrokerAccountRole;
	email?: string;
	subAccountId?: string;
	uid?: string;
};

export type BrokerPoolEntry = {
	primary: BrokerAccount;
	secondaryBrokers: BrokerAccount[];
};

export class BrokerAccountPreconditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrokerAccountPreconditionError";
	}
}

export function requireDestinationEmail(
	dest: BrokerAccount,
	transferType: "sub-to-sub" | "primary-to-sub",
) {
	const email = dest.email?.trim();
	if (!email) {
		throw new BrokerAccountPreconditionError(
			`Destination account '${dest.label}' requires an email configured for ${transferType} transfers`,
		);
	}
	return email;
}

export function applyCommonExchangeConfig(exchange: Exchange) {
	if (process.env.CEX_BROKER_SANDBOX_MODE === "true") {
		exchange.setSandboxMode(true);
	}
	// Ensure consistent defaults
	exchange.enableRateLimit = true;
	exchange.timeout = 150 * 1000;
	exchange.extendExchangeOptions({
		recvWindow: 60000,
		adjustForTimeDifference: true,
	});
	// Register Binance's travel-rule withdraw endpoint (no-op for other exchanges).
	registerBinanceTravelRuleWithdrawEndpoint(exchange);
}

export function createBroker(
	cex: string,
	credsOrMetadata: { apiKey: string; apiSecret: string } | Metadata,
): Exchange | null {
	let apiKey: string | undefined;
	let apiSecret: string | undefined;

	// Duck-typing check for gRPC Metadata (has get/remove functions)
	if (
		credsOrMetadata &&
		typeof (credsOrMetadata as unknown as { get: unknown }).get ===
			"function" &&
		typeof (credsOrMetadata as unknown as { remove: unknown }).remove ===
			"function"
	) {
		const metadata = credsOrMetadata as Metadata;
		apiKey = metadata.get("api-key")?.[0]?.toString();
		apiSecret = metadata.get("api-secret")?.[0]?.toString();
		metadata.remove("api-key");
		metadata.remove("api-secret");
	} else {
		const creds = credsOrMetadata as { apiKey: string; apiSecret: string };
		apiKey = creds.apiKey;
		apiSecret = creds.apiSecret;
	}

	const ExchangeClass = (ccxt.pro as Record<string, typeof Exchange>)[cex];
	if (!ExchangeClass || !apiKey || !apiSecret) {
		return null;
	}

	const config = buildCcxtConfig(cex, { apiKey, apiSecret });
	if (!config) {
		return null;
	}

	const exchange = new ExchangeClass(config);
	applyCommonExchangeConfig(exchange);
	return exchange;
}

export function createPublicBroker(cex: string): Exchange | null {
	const ExchangeClass = (ccxt.pro as Record<string, typeof Exchange>)[cex];
	if (!ExchangeClass) {
		return null;
	}

	const exchange = new ExchangeClass({});
	applyCommonExchangeConfig(exchange);
	return exchange;
}

type EnvConfigMap = Record<
	string,
	Partial<BrokerCredentials> & {
		_secondaryMap?: Record<number, Partial<BrokerCredentials>>;
	}
>;

type ValidatedCredentialsMap = Record<
	string,
	BrokerCredentials & { secondaryKeys: BrokerCredentials[] }
>;

function createBrokerAccount(
	brokerName: string,
	label: BrokerAccount["label"],
	creds: BrokerCredentials,
	index?: number,
): BrokerAccount | null {
	const exchange = createBroker(brokerName, {
		apiKey: creds.apiKey,
		apiSecret: creds.apiSecret,
	});
	if (!exchange) {
		return null;
	}
	return {
		exchange,
		label,
		index,
		role: creds.role,
		email: creds.email,
		subAccountId: creds.subAccountId,
		uid: creds.uid,
	};
}

export function createBrokerPool(
	cfg: EnvConfigMap | ValidatedCredentialsMap,
): Record<string, BrokerPoolEntry> {
	const pool: Record<string, BrokerPoolEntry> = {};

	for (const [brokerName, creds] of Object.entries(cfg)) {
		const ExchangeClass = (ccxt.pro as Record<string, typeof Exchange>)[
			brokerName
		];
		if (!ExchangeClass) {
			log.warn(`❌ Invalid Broker: ${brokerName}`);
			continue;
		}

		const credsRecord = creds as Record<string, unknown>;
		const primaryApiKey =
			typeof credsRecord.apiKey === "string"
				? (credsRecord.apiKey as string)
				: undefined;
		const primaryApiSecret =
			typeof credsRecord.apiSecret === "string"
				? (credsRecord.apiSecret as string)
				: undefined;
		if (!primaryApiKey || !primaryApiSecret) {
			log.warn(`❌ Missing API_KEY and/or API_SECRET for "${brokerName}"`);
			continue;
		}

		const primary = createBrokerAccount(brokerName, "primary", {
			apiKey: primaryApiKey,
			apiSecret: primaryApiSecret,
			role:
				typeof credsRecord.role === "string"
					? (credsRecord.role as BrokerAccountRole)
					: undefined,
			email:
				typeof credsRecord.email === "string"
					? (credsRecord.email as string)
					: undefined,
			subAccountId:
				typeof credsRecord.subAccountId === "string"
					? (credsRecord.subAccountId as string)
					: undefined,
			uid:
				typeof credsRecord.uid === "string"
					? (credsRecord.uid as string)
					: undefined,
		});
		if (!primary) {
			log.warn(`❌ Failed to create primary for "${brokerName}"`);
			continue;
		}

		const secondaryBrokers: BrokerAccount[] = [];
		const secondaryKeysFromValidated = Array.isArray(credsRecord.secondaryKeys)
			? (credsRecord.secondaryKeys as BrokerCredentials[])
			: undefined;
		const secondaryEntriesFromValidated = secondaryKeysFromValidated?.map(
			(sec, idx) => [idx + 1, sec] as const,
		);
		const secondaryEntriesFromMap =
			credsRecord._secondaryMap && typeof credsRecord._secondaryMap === "object"
				? Object.entries(
						credsRecord._secondaryMap as Record<
							number,
							Partial<BrokerCredentials>
						>,
					)
						.filter(
							([, sec]) =>
								typeof sec.apiKey === "string" &&
								typeof sec.apiSecret === "string",
						)
						.map(
							([rawIndex, sec]) =>
								[
									Number(rawIndex),
									{
										apiKey: sec.apiKey as string,
										apiSecret: sec.apiSecret as string,
										role: sec.role,
										email: sec.email,
										subAccountId: sec.subAccountId,
										uid: sec.uid,
									},
								] as const,
						)
				: [];
		const secondaryEntries =
			secondaryEntriesFromValidated ?? secondaryEntriesFromMap;

		secondaryEntries
			.filter(([index]) => Number.isInteger(index) && index > 0)
			.sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
			.forEach(([index, sec]) => {
				const secEx = createBrokerAccount(
					brokerName,
					`secondary:${index}`,
					sec,
					index,
				);
				if (secEx) secondaryBrokers.push(secEx);
				else
					log.warn(
						`⚠️ Failed to create secondary #${index} for "${brokerName}"`,
					);
			});

		pool[brokerName] = { primary, secondaryBrokers };
		log.info(
			`✅ Loaded "${brokerName}" with ${secondaryBrokers.length} secondaries`,
		);
	}

	return pool;
}

export function selectBroker(
	brokers: BrokerPoolEntry | undefined,
	metadata: Metadata,
): Exchange | null {
	return selectBrokerAccount(brokers, metadata)?.exchange ?? null;
}

export function getCurrentBrokerSelector(metadata: Metadata): string {
	const use_secondary_key = metadata.get("use-secondary-key");
	if (!use_secondary_key || use_secondary_key.length === 0) {
		return "primary";
	}
	const rawIndex = use_secondary_key[use_secondary_key.length - 1]?.toString();
	const index = rawIndex ? Number.parseInt(rawIndex, 10) : Number.NaN;
	return Number.isInteger(index) && index > 0
		? `secondary:${index}`
		: "primary";
}

export function resolveBrokerAccount(
	brokers: BrokerPoolEntry | undefined,
	selector: string,
): BrokerAccount | null {
	if (!brokers) {
		return null;
	}
	if (selector === "primary") {
		return brokers.primary;
	}
	const match = selector.match(/^secondary:(\d+)$/);
	if (!match) {
		return null;
	}
	const index = Number.parseInt(match[1] ?? "", 10);
	return Number.isInteger(index) && index > 0
		? (brokers.secondaryBrokers.find((account) => account.index === index) ??
				null)
		: null;
}

export function selectBrokerAccount(
	brokers: BrokerPoolEntry | undefined,
	metadata: Metadata,
): BrokerAccount | null {
	return resolveBrokerAccount(brokers, getCurrentBrokerSelector(metadata));
}
