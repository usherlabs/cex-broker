delete process.env.CEX_BROKER_ARCHIVE_ENABLED;

const { default: CEXBroker } = await import("../dist/index.js");
const broker = new CEXBroker(
	{},
	{
		withdraw: { rule: [] },
		deposit: {},
		order: { rule: { markets: [], limits: [] } },
	},
);

await broker.stop();
console.log("Node package import and construction passed");
