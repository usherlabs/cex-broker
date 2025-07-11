import CEXBroker from '../index';

/**
 * CLI Command wrapper to start the CEXBroker
 */
export async function startBrokerCommand(policyPath: string, port: number) {
    const broker = new CEXBroker({}, policyPath, { port });
    broker.loadEnvConfig();
    await broker.run();
}
