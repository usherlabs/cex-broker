import type ccxt from "@usherlabs/ccxt";

// Policy types based on the policy.json structure
export type WithdrawRuleEntry = {
	exchange: string;
	network: string;
	whitelist: string[];
};

export type OrderRule = {
	markets: string[];
	limits?: Array<{
		from: string;
		to: string;
		min: number;
		max: number;
	}>;
};

export type PolicyConfig = {
	withdraw: {
		rule: WithdrawRuleEntry[];
	};
	deposit: Record<string, null>;
	order: {
		rule: OrderRule;
	};
};

// Dynamic type mapping using CCXT's exchange classes
type BrokerInstanceMap = {
	[K in ISupportedBroker]: InstanceType<(typeof ccxt)[K]>;
};

// Dynamic BrokerMap: each key maps to the correct broker type
export type BrokerMap = Partial<{
	[K in ISupportedBroker]: BrokerInstanceMap[K];
}>;

export const BrokerList = [
	"alpaca",
	"apex",
	"ascendex",
	"bequant",
	"bigone",
	"binance",
	"binancecoinm",
	"binanceus",
	"binanceusdm",
	"bingx",
	"bit2c",
	"bitbank",
	"bitbns",
	"bitfinex",
	"bitflyer",
	"bitget",
	"bithumb",
	"bitmart",
	"bitmex",
	"bitopro",
	"bitrue",
	"bitso",
	"bitstamp",
	"bitteam",
	"bittrade",
	"bitvavo",
	"blockchaincom",
	"blofin",
	"btcalpha",
	"btcbox",
	"btcmarkets",
	"btcturk",
	"bybit",
	"cex",
	"coinbase",
	"coinbaseadvanced",
	"coinbaseexchange",
	"coinbaseinternational",
	"coincatch",
	"coincheck",
	"coinex",
	"coinmate",
	"coinmetro",
	"coinone",
	"coinsph",
	"coinspot",
	"cryptocom",
	"cryptomus",
	"defx",
	"delta",
	"deribit",
	"derive",
	"digifinex",
	"ellipx",
	"exmo",
	"fmfwio",
	"gate",
	"gateio",
	"gemini",
	"hashkey",
	"hitbtc",
	"hollaex",
	"htx",
	"huobi",
	"hyperliquid",
	"independentreserve",
	"indodax",
	"kraken",
	"krakenfutures",
	"kucoin",
	"kucoinfutures",
	"latoken",
	"lbank",
	"luno",
	"mercado",
	"mexc",
	"modetrade",
	"myokx",
	"ndax",
	"novadax",
	"oceanex",
	"okcoin",
	"okx",
	"okxus",
	"onetrading",
	"oxfun",
	"p2b",
	"paradex",
	"paymium",
	"phemex",
	"poloniex",
	"probit",
	"timex",
	"tokocrypto",
	"tradeogre",
	"upbit",
	"vertex",
	"wavesexchange",
	"whitebit",
	"woo",
	"woofipro",
	"xt",
	"yobit",
	"zaif",
	"zonda",
] as const;

export type brokers = Required<BrokerMap>;

export type ISupportedBroker = (typeof BrokerList)[number];
export type SupportedBrokers = (typeof BrokerList)[number];

export const SupportedBroker = BrokerList.reduce(
	(acc, value) => {
		acc[value] = value;
		return acc;
	},
	{} as Record<(typeof BrokerList)[number], string>,
);

export type BrokerCredentials = {
	apiKey: string;
	apiSecret: string;
};
export type SecondaryKeys<T> = {
	secondaryKeys: Array<T>;
};

export interface ExchangeCredentials {
	[exchange: string]: BrokerCredentials & SecondaryKeys<BrokerCredentials>;
}
