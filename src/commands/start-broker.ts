import CEXBroker from "../index";

/**
 * CLI Command wrapper to start the CEXBroker
 */
export async function startBrokerCommand(
	policyPath: string,
	port: number,
	whitelistIps: string[],
	verityProverUrl: string,
) {
	const broker = new CEXBroker({}, policyPath, {
		port,
		whitelistIps,
		verityProverUrl,
		useVerity: !!verityProverUrl,
	});
	broker.loadEnvConfig();
	await broker.run();
}
