import CEXBroker from "../index";
import type { PolicyConfig } from "../types";

const emptyPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

export function getProbeCredentialsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
) {
	const apiKey = env.CEX_BROKER_PROBE_API_KEY;
	const apiSecret = env.CEX_BROKER_PROBE_API_SECRET;

	if (!apiKey && !apiSecret) {
		return null;
	}

	if (!apiKey || !apiSecret) {
		throw new Error(
			"CEX_BROKER_PROBE_API_KEY and CEX_BROKER_PROBE_API_SECRET must both be set for raw probe mode",
		);
	}

	return { apiKey, apiSecret };
}

export async function runProbeAuth(
	broker: Pick<
		CEXBroker,
		"loadEnvConfig" | "probeAuth" | "probeAuthWithCredentials"
	>,
	exchange: string,
	accountSelector: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	const probeCreds = getProbeCredentialsFromEnv(env);
	if (probeCreds) {
		return broker.probeAuthWithCredentials(exchange, probeCreds);
	}

	broker.loadEnvConfig();
	return broker.probeAuth(exchange, accountSelector);
}

export async function probeAuthCommand(
	exchange: string,
	accountSelector: string,
) {
	const broker = new CEXBroker({}, emptyPolicy);
	const result = await runProbeAuth(broker, exchange, accountSelector);
	console.log(JSON.stringify(result, null, 2));
}
