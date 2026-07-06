import type { BrokerSurface } from "../helpers/broker-surface";
import {
	resolveBrokerSurfaceFromEnv,
	validateBrokerSurface,
} from "../helpers/broker-surface";
import CEXBroker from "../index";

/**
 * CLI Command wrapper to start the CEXBroker
 */
export async function startBrokerCommand(
	policyPath: string,
	port: number,
	whitelistIps: string[],
	verityProverUrl: string,
	brokerSurface?: Partial<BrokerSurface>,
) {
	const resolvedSurface: BrokerSurface = {
		...resolveBrokerSurfaceFromEnv(),
		...brokerSurface,
	};
	validateBrokerSurface(resolvedSurface);

	const broker = new CEXBroker({}, policyPath, {
		port,
		whitelistIps,
		verityProverUrl,
		useVerity: !!verityProverUrl,
		brokerSurface: resolvedSurface,
	});
	broker.loadEnvConfig();
	await broker.run();
}
