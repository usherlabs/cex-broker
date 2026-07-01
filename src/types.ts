import type ccxt from "@usherlabs/ccxt";

// Policy types based on the policy.json structure
export type WithdrawRuleEntry = {
	exchange: string;
	network: string;
	whitelist: string[];
	coins?: string[];
};

export type DepositRuleEntry = {
	exchange: string;
	network: string;
	coins?: string[];
};

export type BrokerAccountRole = "master" | "subaccount";

export type OrderRule = {
	markets: string[];
	limits?: Array<{
		from: string;
		to: string;
		min: number;
		max: number;
	}>;
};

// Binance travel-rule questionnaire answers (Australia). Optional fields are
// conditionally required; see australiaQuestionnaireSchema for the exact rules.
export type TravelRuleQuestionnaire = {
	isAddressOwner: number;
	sendTo: number;
	declaration: boolean;
	bnfType?: number;
	bnfFirstName?: string;
	bnfLastName?: string;
	country?: string;
	city?: string;
	bnfCorpName?: string;
	bnfCorpCountry?: string;
	bnfCorpCity?: string;
	vasp?: string;
	vaspName?: string;
};

export type TravelRuleAddressEntry = {
	questionnaire: TravelRuleQuestionnaire;
};

export type TravelRuleEntry = {
	exchange: string;
	// Opt-in switch: only when true are withdrawals for this exchange routed
	// through the travel-rule endpoint. Keeps non-AU accounts on the standard path.
	enabled: boolean;
	// Free-text note explaining why this entry exists (e.g. which jurisdiction
	// requires it). Ignored by the runtime; documents intent next to the config.
	description?: string;
	// Keyed by destination address; the questionnaire is resolved on demand at
	// withdraw time. Matching is case-insensitive.
	addresses: Record<string, TravelRuleAddressEntry>;
};

export type PolicyConfig = {
	withdraw: {
		rule: WithdrawRuleEntry[];
	};
	deposit: {
		rule?: DepositRuleEntry[];
	};
	order: {
		rule: OrderRule;
	};
	travelRule?: {
		rule: TravelRuleEntry[];
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
	role?: BrokerAccountRole;
	email?: string;
	subAccountId?: string;
	uid?: string;
};
export type SecondaryKeys<T> = {
	secondaryKeys: Array<T>;
};

export interface ExchangeCredentials {
	[exchange: string]: BrokerCredentials & SecondaryKeys<BrokerCredentials>;
}
