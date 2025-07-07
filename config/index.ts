import dotenv from "dotenv";
import Joi from "joi";
import { BrokerList, SupportedBroker } from "../types";

dotenv.config();

const baseConfig = {
	port: process.env.PORT_NUM,
	// TODO: We can make these environment variables more dynamic... eg. CEX_API_KEY_[EXCHANGE_NAMESPACE]_[NUMBER] - in case many exchanges for same exchange.
	bybitApiKey: process.env.BYBIT_API_KEY,
	bybitApiSecret: process.env.BYBIT_API_SECRET,
	binanceApiKey: process.env.BINANCE_API_KEY,
	binanceApiSecret: process.env.BINANCE_API_SECRET,
	// TODO: Terrible naming convention? What is Rooch doing here...
	// TODO: This "brokers" should be called "exchanges".... right?
	brokers: (process.env.ROOCH_CHAIN_ID
		? process.env.ROOCH_CHAIN_ID.split(",")
		: BrokerList) as string[],
};

const isRequiredWhenBrokerInclude = (
	schema: Joi.StringSchema<string>,
	value: string,
) =>
	Joi.string().when("brokers", {
		is: Joi.array().items(Joi.string().valid(value)).has(value),
		// biome-ignore lint/suspicious/noThenProperty: Dynamic check
		then: schema.required(), // 'details' is required if 'status' is 'active'
		otherwise: Joi.string().optional().allow("", null).default(""), // 'details' is optional otherwise
	});

const envVarsSchema = Joi.object({
	port: Joi.number().default(8082),
	bybitApiKey: isRequiredWhenBrokerInclude(Joi.string(), SupportedBroker.BYBIT),
	bybitApiSecret: isRequiredWhenBrokerInclude(
		Joi.string(),
		SupportedBroker.BYBIT,
	),
	binanceApiKey: isRequiredWhenBrokerInclude(
		Joi.string(),
		SupportedBroker.BINANCE,
	),
	binanceApiSecret: isRequiredWhenBrokerInclude(
		Joi.string(),
		SupportedBroker.BINANCE,
	),
}).unknown();

const { value: envVars, error } = envVarsSchema.validate({
	...baseConfig,
});

if (error) {
	throw new Error(`Config validation error: ${error.message}`);
}

export default envVars as typeof baseConfig;
