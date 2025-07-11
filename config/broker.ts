import ccxt from "ccxt";
import type { alpaca,
	apex,
	ascendex,
	bequant,
	bigone,
	binance,
	binancecoinm,
	binanceus,
	binanceusdm,
	bingx,
	bit2c,
	bitbank,
	bitbns,
	bitfinex,
	bitflyer,
	bitget,
	bithumb,
	bitmart,
	bitmex,	bitopro,
	bitrue,	bitso,bitstamp,
	bitteam,
	bittrade,
	bitvavo,
	blockchaincom,
	blofin,
	btcalpha,
	btcbox,
	btcmarkets,
	btcturk,
	bybit,
	cex,	
	coinbase,
	coinbaseadvanced,
	coinbaseexchange,
	coinbaseinternational,
	coincatch,
	coincheck,
	coinex,
	coinmate,
	coinmetro,
	coinone,
	coinsph,
	coinspot,
	cryptocom,
	cryptomus,
	defx,
	delta,
	deribit,
	derive,
	digifinex,
	ellipx,
	exmo,
	fmfwio,
	gate,
	gateio,
	gemini,
	hashkey,
	hitbtc,
	hollaex,
	htx,
	huobi,
	hyperliquid,
	independentreserve,
	indodax,
	kraken,
	krakenfutures,
	kucoin,
	kucoinfutures,
	latoken,
	lbank,
	luno,
	mercado,
	mexc,
	modetrade,
	myokx,
	ndax,
	novadax,
	oceanex,
	okcoin,
	okx,
	okxus,
	onetrading,
	oxfun,
	p2b,
	paradex,
	paymium,
	phemex,
	poloniex,
	probit,
	timex,
	tokocrypto,
	tradeogre,
	upbit,
	vertex,
	wavesexchange,
	whitebit,
	woo,
	woofipro,
	xt,
	yobit,
	zaif,
	zonda,
} from "ccxt"
import { SupportedBroker } from "../types";
import type { ISupportedBroker } from "../types";

// Map each broker key to its specific CCXT class
type BrokerInstanceMap = {
	[SupportedBroker.alpaca]: alpaca;
	[SupportedBroker.apex]: apex;
	[SupportedBroker.ascendex]: ascendex;
	[SupportedBroker.bequant]: bequant;
	[SupportedBroker.bigone]: bigone;
	[SupportedBroker.binance]: binance;
	[SupportedBroker.binancecoinm]: binancecoinm;
	[SupportedBroker.binanceus]: binanceus;
	[SupportedBroker.binanceusdm]: binanceusdm;
	[SupportedBroker.bingx]: bingx;
	[SupportedBroker.bit2c]: bit2c;
	[SupportedBroker.bitbank]: bitbank;
	[SupportedBroker.bitbns]: bitbns;
	[SupportedBroker.bitfinex]: bitfinex;
	[SupportedBroker.bitflyer]: bitflyer;
	[SupportedBroker.bitget]: bitget;
	[SupportedBroker.bithumb]: bithumb;
	[SupportedBroker.bitmart]: bitmart;
	[SupportedBroker.bitmex]: bitmex;
	[SupportedBroker.bitopro]: bitopro;
	[SupportedBroker.bitrue]: bitrue;
	[SupportedBroker.bitso]: bitso;
	[SupportedBroker.bitstamp]: bitstamp;
	[SupportedBroker.bitteam]: bitteam;
	[SupportedBroker.bittrade]: bittrade;
	[SupportedBroker.bitvavo]: bitvavo;
	[SupportedBroker.blockchaincom]: blockchaincom;
	[SupportedBroker.blofin]: blofin;
	[SupportedBroker.btcalpha]: btcalpha;
	[SupportedBroker.btcbox]: btcbox;
	[SupportedBroker.btcmarkets]: btcmarkets;
	[SupportedBroker.btcturk]: btcturk;
	[SupportedBroker.bybit]: bybit;
	[SupportedBroker.cex]: cex;
	[SupportedBroker.coinbase]: coinbase;
	[SupportedBroker.coinbaseadvanced]: coinbaseadvanced;
	[SupportedBroker.coinbaseexchange]: coinbaseexchange;
	[SupportedBroker.coinbaseinternational]: coinbaseinternational;
	[SupportedBroker.coincatch]: coincatch;
	[SupportedBroker.coincheck]: coincheck;
	[SupportedBroker.coinex]: coinex;
	[SupportedBroker.coinmate]: coinmate;
	[SupportedBroker.coinmetro]: coinmetro;
	[SupportedBroker.coinone]: coinone;
	[SupportedBroker.coinsph]: coinsph;
	[SupportedBroker.coinspot]: coinspot;
	[SupportedBroker.cryptocom]: cryptocom;
	[SupportedBroker.cryptomus]: cryptomus;
	[SupportedBroker.defx]: defx;
	[SupportedBroker.delta]: delta;
	[SupportedBroker.deribit]: deribit;
	[SupportedBroker.derive]: derive;
	[SupportedBroker.digifinex]: digifinex;
	[SupportedBroker.ellipx]: ellipx;
	[SupportedBroker.exmo]: exmo;
	[SupportedBroker.fmfwio]: fmfwio;
	[SupportedBroker.gate]: gate;
	[SupportedBroker.gateio]: gateio;
	[SupportedBroker.gemini]: gemini;
	[SupportedBroker.hashkey]: hashkey;
	[SupportedBroker.hitbtc]: hitbtc;
	[SupportedBroker.hollaex]: hollaex;
	[SupportedBroker.htx]: htx;
	[SupportedBroker.huobi]: huobi;
	[SupportedBroker.hyperliquid]: hyperliquid;
	[SupportedBroker.independentreserve]: independentreserve;
	[SupportedBroker.indodax]: indodax;
	[SupportedBroker.kraken]: kraken;
	[SupportedBroker.krakenfutures]: krakenfutures;
	[SupportedBroker.kucoin]: kucoin;
	[SupportedBroker.kucoinfutures]: kucoinfutures;
	[SupportedBroker.latoken]: latoken;
	[SupportedBroker.lbank]: lbank;
	[SupportedBroker.luno]: luno;
	[SupportedBroker.mercado]: mercado;
	[SupportedBroker.mexc]: mexc;
	[SupportedBroker.modetrade]: modetrade;
	[SupportedBroker.myokx]: myokx;
	[SupportedBroker.ndax]: ndax;
	[SupportedBroker.novadax]: novadax;
	[SupportedBroker.oceanex]: oceanex;
	[SupportedBroker.okcoin]: okcoin;
	[SupportedBroker.okx]: okx;
	[SupportedBroker.okxus]: okxus;
	[SupportedBroker.onetrading]: onetrading;
	[SupportedBroker.oxfun]: oxfun;
	[SupportedBroker.p2b]: p2b;
	[SupportedBroker.paradex]: paradex;
	[SupportedBroker.paymium]: paymium;
	[SupportedBroker.phemex]: phemex;
	[SupportedBroker.poloniex]: poloniex;
	[SupportedBroker.probit]: probit;
	[SupportedBroker.timex]: timex;
	[SupportedBroker.tokocrypto]: tokocrypto;
	[SupportedBroker.tradeogre]: tradeogre;
	[SupportedBroker.upbit]: upbit;
	[SupportedBroker.vertex]: vertex;
	[SupportedBroker.wavesexchange]: wavesexchange;
	[SupportedBroker.whitebit]: whitebit;
	[SupportedBroker.woo]: woo;
	[SupportedBroker.woofipro]: woofipro;
	[SupportedBroker.xt]: xt;
	[SupportedBroker.yobit]: yobit;
	[SupportedBroker.zaif]: zaif;
	[SupportedBroker.zonda]: zonda;
  };
  
// Dynamic BrokerMap: each key maps to the correct broker type
export type BrokerMap = Partial<{
	[K in ISupportedBroker]: BrokerInstanceMap[K];
}>;


// Initialize brokers map
const brokers: BrokerMap = {};


export default brokers as Required<BrokerMap>;
