import CEXBroker from '../index';

/**
 * CLI Command wrapper to start the CEXBroker
 */
export async function startBrokerCommand(policyPath: string, port: number,whitelistIps: string[],url: string) {
    const broker = new CEXBroker({}, policyPath, { port,whitelistIps,verityProverUrl: url });
    broker.loadEnvConfig();
    await broker.run();
}
