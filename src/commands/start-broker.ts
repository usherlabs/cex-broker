import CEXBroker from "../index";

/**
 * CLI Command wrapper to start the CEXBroker
 */
export async function startBrokerCommand(
	policyPath: string,
	port: number,
	whitelistIps: string[],
	verityProverUrl: string,
	unaryMarketOnly = false,
	bindHost?: string,
): Promise<CEXBroker> {
	const broker = new CEXBroker({}, policyPath, {
		port,
		whitelistIps,
		verityProverUrl,
		useVerity: !!verityProverUrl,
		unaryMarketOnly,
		bindHost,
	});
	broker.loadEnvConfig();
	await broker.run();
	return broker;
}
