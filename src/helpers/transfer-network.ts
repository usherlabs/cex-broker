import type { Exchange } from "@usherlabs/ccxt";
import { normalizeBrokerNetworkId } from "./index";
import { safeLogError } from "./shared/errors";
import { isRecord } from "./shared/guards";
import { fetchCurrencyMetadata } from "./treasury-discovery";

export type TransferNetworkResolution = {
	operatorAlias: string;
	brokerNetworkId: string;
	exchangeNetworkId: string;
	networkKey: string | null;
};

function networkAliasSet(
	brokerNetworkId: string,
	networkKey: string,
): string[] {
	const aliases = new Set<string>([
		brokerNetworkId,
		networkKey.trim().toUpperCase(),
	]);
	if (brokerNetworkId === "BNB") {
		aliases.add("BNB");
		aliases.add("BSC");
		aliases.add("BEP20");
	}
	return [...aliases].filter((alias) => alias.length > 0);
}

export function buildTransferNetworkEvidence(
	currencyInfo: Record<string, unknown>,
) {
	const rawNetworks = isRecord(currencyInfo.networks)
		? currencyInfo.networks
		: {};
	const networks: Record<string, unknown> = {};
	const aliases: Record<string, TransferNetworkResolution> = {};

	for (const [networkKey, networkValue] of Object.entries(rawNetworks)) {
		const networkRecord = isRecord(networkValue) ? networkValue : {};
		const exchangeNetworkId = String(
			networkRecord.id ?? networkRecord.network ?? networkKey,
		);
		const brokerNetworkId = normalizeBrokerNetworkId(
			String(networkRecord.network ?? networkKey),
		);
		const evidence = {
			operatorAlias: networkKey,
			brokerNetworkId,
			exchangeNetworkId,
			networkKey,
		};
		networks[networkKey] = {
			...networkRecord,
			operatorAlias: networkKey,
			brokerNetworkId,
			exchangeNetworkId,
		};
		for (const alias of networkAliasSet(brokerNetworkId, networkKey)) {
			aliases[alias] = { ...evidence, operatorAlias: alias };
		}
	}

	return { networks, aliases };
}

export async function resolveTransferNetwork(
	broker: Exchange,
	assetCode: string,
	operatorAlias: string,
): Promise<TransferNetworkResolution> {
	const requestedAlias = operatorAlias.trim().toUpperCase();
	const brokerNetworkId = normalizeBrokerNetworkId(requestedAlias);
	let currencyInfo: Record<string, unknown> | null | undefined = null;
	try {
		currencyInfo = await fetchCurrencyMetadata(broker, assetCode);
	} catch (error) {
		safeLogError(
			`Network discovery failed for ${assetCode}/${operatorAlias}; using operator alias as exchange network id`,
			error,
		);
	}
	if (currencyInfo) {
		const evidence = buildTransferNetworkEvidence(currencyInfo);
		const resolved =
			evidence.aliases[requestedAlias] ?? evidence.aliases[brokerNetworkId];
		if (resolved) {
			return { ...resolved, operatorAlias: requestedAlias, brokerNetworkId };
		}
		throw new Error(
			`network_alias_unresolved: ${assetCode}/${requestedAlias} is not available in discovered transfer networks`,
		);
	}
	return {
		operatorAlias: requestedAlias,
		brokerNetworkId,
		exchangeNetworkId: requestedAlias,
		networkKey: null,
	};
}
