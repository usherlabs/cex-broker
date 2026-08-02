import type { Exchange } from "@usherlabs/ccxt";
import { log } from "../../helpers/logger";

type BrokerContext = {
	cex: string;
	symbol: string;
};

export type BrokerCloseOutcome = "closed" | "failed";

export class SubscribeBrokerLifecycle {
	readonly #brokers = new Map<Exchange, BrokerContext>();
	readonly #closing = new Map<Exchange, Promise<BrokerCloseOutcome>>();
	#shuttingDown = false;

	register(broker: Exchange, context: BrokerContext): void {
		this.#brokers.set(broker, context);
		if (this.#shuttingDown) {
			void this.close(broker);
		}
	}

	// Never rejects: per-broker close failures are logged and reported through
	// the outcome so fire-and-forget callers (stream end/cancel paths) stay safe.
	close(broker: Exchange): Promise<BrokerCloseOutcome> {
		const existing = this.#closing.get(broker);
		if (existing) {
			return existing;
		}

		const context = this.#brokers.get(broker) ?? {
			cex: "unknown",
			symbol: "unknown",
		};
		this.#brokers.delete(broker);
		const closing = (async (): Promise<BrokerCloseOutcome> => {
			try {
				await broker.close();
				log.debug("Request-scoped Subscribe broker closed", context);
				return "closed";
			} catch (error) {
				log.warn("Failed to close request-scoped Subscribe broker", {
					...context,
					error,
				});
				return "failed";
			} finally {
				this.#closing.delete(broker);
			}
		})();
		this.#closing.set(broker, closing);
		return closing;
	}

	// Drains in a loop so brokers registered while shutdown is already in
	// progress are still awaited, and rejects when any close failed so callers
	// treat shutdown as incomplete (the collector then force-exits within its
	// bounded deadline instead of hanging on leaked exchange handles).
	async closeAll(): Promise<void> {
		this.#shuttingDown = true;
		let failed = 0;
		while (this.#brokers.size > 0 || this.#closing.size > 0) {
			const inFlight = [...this.#closing.values()];
			const fresh = [...this.#brokers.keys()].map((broker) =>
				this.close(broker),
			);
			const outcomes = await Promise.all([...fresh, ...inFlight]);
			failed += outcomes.filter((outcome) => outcome === "failed").length;
		}
		if (failed > 0) {
			throw new Error(
				`${failed} request-scoped Subscribe broker(s) failed to close`,
			);
		}
	}
}
