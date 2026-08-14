import type { BrokerPoolEntry } from "./broker";
import {
	type BrokerExecutionArchiver,
	buildCommonArchiveTags,
	buildTransferEventArchiveRow,
	normalizeTimestamp,
} from "./broker-execution-archive";
import { log } from "./logger";
import type {
	UserDataStreamSupervisor,
	UserDataSubscription,
} from "./user-data-stream-supervisor";

type BalanceUpdateArchiveTarget = {
	exchange: string;
	accountSelector: string;
};

type BalanceUpdateSubscriptionSource = Pick<
	UserDataStreamSupervisor,
	"subscribe"
>;

export class BalanceUpdateArchiveConsumer {
	#started = false;
	#stopping = false;
	readonly #subscriptions = new Set<UserDataSubscription>();
	readonly #runs: Promise<void>[] = [];

	constructor(
		private readonly params: {
			brokers: Record<string, BrokerPoolEntry>;
			archiver: BrokerExecutionArchiver;
			userDataStreamSupervisor: BalanceUpdateSubscriptionSource;
		},
	) {}

	start(): void {
		if (this.#started || this.#stopping) return;
		this.#started = true;
		const targets = this.#targets();
		log.info("💸 Balance-update archive consumer started", {
			accounts: targets.length,
		});
		for (const target of targets) {
			this.#runs.push(this.#consume(target));
		}
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		for (const subscription of [...this.#subscriptions]) {
			subscription.close();
		}
		await Promise.all(this.#runs);
	}

	#targets(): BalanceUpdateArchiveTarget[] {
		const targets: BalanceUpdateArchiveTarget[] = [];
		for (const [exchange, pool] of Object.entries(this.params.brokers)) {
			for (const account of [pool.primary, ...pool.secondaryBrokers]) {
				targets.push({ exchange, accountSelector: account.label });
			}
		}
		return targets;
	}

	async #consume(target: BalanceUpdateArchiveTarget): Promise<void> {
		while (!this.#stopping) {
			let subscription: UserDataSubscription | undefined;
			try {
				subscription = this.params.userDataStreamSupervisor.subscribe({
					exchange: target.exchange,
					accountSelector: target.accountSelector,
					kind: "balance",
				});
				this.#subscriptions.add(subscription);
				for await (const message of subscription) {
					if (this.#stopping) break;
					const event = message.event;
					if (event.e !== "balanceUpdate") continue;
					this.params.archiver.enqueue(
						buildTransferEventArchiveRow({
							tags: buildCommonArchiveTags({
								deploymentId: this.params.archiver.getDeploymentId(),
								accountSelector: target.accountSelector,
								exchange: target.exchange,
							}),
							transfer: {
								eventKind: "balance_delta",
								lifecycleAction: "observe_balance_update",
								amount: typeof event.d === "string" ? event.d : undefined,
								assetSymbol: typeof event.a === "string" ? event.a : undefined,
								exchangeTimestamp: normalizeTimestamp(event.T),
								payload: event,
							},
						}),
					);
				}
			} catch (error) {
				if (!this.#stopping) {
					log.warn("Balance-update archive subscription failed", {
						exchange: target.exchange,
						accountSelector: target.accountSelector,
						errorType: error instanceof Error ? error.name : typeof error,
					});
				}
			} finally {
				if (subscription) {
					this.#subscriptions.delete(subscription);
					subscription.close();
				}
			}
		}
	}
}
