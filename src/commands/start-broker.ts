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
): Promise<CEXBroker> {
	const broker = new CEXBroker({}, policyPath, {
		port,
		whitelistIps,
		verityProverUrl,
		useVerity: !!verityProverUrl,
		unaryMarketOnly,
	});
	broker.loadEnvConfig();
	await broker.run();
	return broker;
}
