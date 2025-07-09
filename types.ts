// Policy types based on the policy.json structure
export type WithdrawRule = {
	networks: string[];
	whitelist: string[];
	amounts: {
		ticker: string;
		max: number;
		min: number;
	}[];
};

export type OrderRule = {
	markets: string[];
	limits: Array<{
		from: string;
		to: string;
		min: number;
		max: number;
	}>;
};

export type PolicyConfig = {
	withdraw: {
		rule: WithdrawRule;
	};
	deposit: Record<string, null>;
	order: {
		rule: OrderRule;
	};
};

// Legacy types (keeping for backward compatibility)
export type Policy = {
	isActive: boolean;
	permissions: Array<"withdraw" | "transfer" | "convert">;
	limits: {
		dailyWithdrawLimit?: number;
		dailyTransferredAmount?: number;
		perTxTransferLimit?: number;
	};
	networks: string[];
	conversionLimits: Array<{
		from: string;
		to: string;
		min: number;
		max: number;
	}>;
};

export type Policies = {
	[apiKey: string]: Policy; // key is an Ethereum-style address like '0x...'
};
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
	"zonda"
  ] as const;
  
export type ISupportedBroker = (typeof BrokerList)[number];

export const SupportedBroker = BrokerList.reduce(
	(acc, value) => {
		acc[value] = value;
		return acc;
	},
	{} as Record<(typeof BrokerList)[number], string>,
);
