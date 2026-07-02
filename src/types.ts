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

// Binance travel-rule DEPOSIT questionnaire answers (Australia). This is a
// DIFFERENT shape from the withdraw questionnaire: it uses
// `depositOriginator`/`receiveFrom` rather than `isAddressOwner`/`sendTo`. Only
// the self-owned case is exercised by the auto-clear reconciler (which only ever
// declares deposits provably sent from our own configured wallets); the proven
// answer for that case is { depositOriginator: 1, receiveFrom: 1, declaration:
// true }. Validated at policy-load by australiaDepositQuestionnaireSchema.
export type TravelRuleDepositQuestionnaire = {
	depositOriginator: number;
	receiveFrom: number;
	declaration: boolean;
};

export type TravelRuleDepositOriginatorEntry = {
	questionnaire: TravelRuleDepositQuestionnaire;
};

// Deposit-side travel-rule config, nested under a TravelRuleEntry. Absent or
// `enabled: false` means the deposit auto-clear reconciler does nothing for the
// exchange — byte-identical to the pre-feature behavior.
export type TravelRuleDepositConfig = {
	enabled: boolean;
	// Free-text note documenting intent (e.g. that keys are SENDERS, and how to add
	// a new funding wallet). Ignored by the runtime.
	description?: string;
	// Keyed by the on-chain SENDER (originator) address. A travel-rule-frozen
	// deposit is auto-declared only when its PROVEN on-chain sender matches one of
	// these entries; matching is case-insensitive. A deposit from any other sender
	// is left frozen and surfaced — never auto-attested.
	originators: Record<string, TravelRuleDepositOriginatorEntry>;
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
	// Deposit-side auto-clear config. Independent of `enabled` (which gates the
	// withdraw leg only): the deposit reconciler is gated solely by
	// `deposits.enabled` so the two legs can be toggled separately.
	deposits?: TravelRuleDepositConfig;
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
