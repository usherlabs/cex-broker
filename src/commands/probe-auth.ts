import CEXBroker from "../index";
import type { PolicyConfig } from "../types";

const emptyPolicy: PolicyConfig = {
	withdraw: { rule: [] },
	deposit: {},
	order: { rule: { markets: [], limits: [] } },
};

export async function probeAuthCommand(
	exchange: string,
	accountSelector: string,
) {
	const broker = new CEXBroker({}, emptyPolicy);
	broker.loadEnvConfig();
	const result = await broker.probeAuth(exchange, accountSelector);
	console.log(JSON.stringify(result, null, 2));
}
