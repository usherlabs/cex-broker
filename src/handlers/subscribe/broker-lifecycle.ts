import type { Exchange } from "@usherlabs/ccxt";
import { log } from "../../helpers/logger";

type BrokerContext = {
	cex: string;
	symbol: string;
};

export class SubscribeBrokerLifecycle {
	readonly #brokers = new Map<Exchange, BrokerContext>();
	readonly #closing = new Map<Exchange, Promise<void>>();
	#shuttingDown = false;

	register(broker: Exchange, context: BrokerContext): void {
		this.#brokers.set(broker, context);
		if (this.#shuttingDown) {
			void this.close(broker);
		}
	}

	close(broker: Exchange): Promise<void> {
		const existing = this.#closing.get(broker);
		if (existing) {
			return existing;
		}

		const context = this.#brokers.get(broker) ?? {
			cex: "unknown",
			symbol: "unknown",
		};
		this.#brokers.delete(broker);
		const closing = (async () => {
			try {
				await broker.close();
				log.debug("Request-scoped Subscribe broker closed", context);
			} catch (error) {
				log.warn("Failed to close request-scoped Subscribe broker", {
					...context,
					error,
				});
			} finally {
				this.#closing.delete(broker);
			}
		})();
		this.#closing.set(broker, closing);
		return closing;
	}

	async closeAll(): Promise<void> {
		this.#shuttingDown = true;
		const closes = [...this.#brokers.keys()].map((broker) =>
			this.close(broker),
		);
		await Promise.all([...closes, ...this.#closing.values()]);
	}
}
