import type { Metadata } from "@grpc/grpc-js";
import type { Exchange } from "@usherlabs/ccxt";
import {
	type BrokerAccount,
	type BrokerPoolEntry,
	createBroker,
	createPublicBroker,
	selectBrokerAccount,
} from "../index";

export function resolveActionBroker(
	normalizedCex: string,
	brokers: Record<string, BrokerPoolEntry>,
	metadata: Metadata,
	selectedBrokerAccount?: BrokerAccount,
): Exchange | null {
	return (
		selectedBrokerAccount?.exchange ??
		createBroker(normalizedCex, metadata) ??
		createPublicBroker(normalizedCex)
	);
}

export function selectBrokerAccountForCex(
	normalizedCex: string,
	brokers: Record<string, BrokerPoolEntry>,
	metadata: Metadata,
): BrokerAccount | undefined {
	return (
		selectBrokerAccount(
			brokers[normalizedCex as keyof typeof brokers],
			metadata,
		) ?? undefined
	);
}
