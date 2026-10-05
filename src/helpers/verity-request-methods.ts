/**
 * Request URL prefixes per ccxt exchange id, mapped to the ccxt method that
 * sends them. The first matching prefix wins, so entry order matters.
 *
 * Only prefixes that attribute a request to a Verity-proved method are kept,
 * plus the earlier prefixes that shadow one of them under first-match lookup.
 * Every other request resolves to no method and is sent without Verity.
 */
export const VERITY_REQUEST_METHODS: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = {
	gate: {
		"https://api.gateio.ws/api/v4/wallet/deposit_address":
			"fetchDepositAddress",
		"https://api.gateio.ws/api/v4/withdrawals": "withdraw",
		"https://api.gateio.ws/api/v4/spot/accounts": "fetchBalance",
		"https://api.gateio.ws/api/v4/margin/accounts": "fetchBalance",
		"https://api.gateio.ws/api/v4/margin/cross/accounts": "fetchBalance",
		"https://api.gateio.ws/api/v4/margin/funding_accounts": "fetchBalance",
		"https://api.gateio.ws/api/v4/futures/usdt/accounts": "fetchBalance",
		"https://api.gateio.ws/api/v4/delivery/btc/accounts": "fetchBalance",
		"https://api.gateio.ws/api/v4/options/accounts": "fetchBalance",
		"https://api.gateio.ws/api/v4/unified/accounts": "fetchBalance",
		"https://api.gateio.ws/api/v4/wallet/deposits": "fetchDeposits",
		"https://api.gateio.ws/api/v4/wallet/withdrawals": "fetchWithdrawals",
		"https://api.gateio.ws/api/v4/futures/usdt/account_book":
			"fetchFundingHistory",
		"https://api.gateio.ws/api/v4/delivery/usdt/account_book":
			"fetchFundingHistory",
	},
	bitmex: {
		"https://testnet.bitmex.com/api/v1/user/depositAddress":
			"fetchDepositAddress",
	},
	krakenfutures: {
		"https://futures.kraken.com/derivatives/api/v3/accounts": "fetchBalance",
	},
	hitbtc: {
		"https://api.hitbtc.com/api/3/spot/balance": "fetchBalance",
		"https://api.hitbtc.com/api/3/wallet/transactions": "fetchWithdrawals",
		"https://api.hitbtc.com/api/3/wallet/crypto/address": "fetchDepositAddress",
	},
	blockchaincom: {
		"https://api.blockchain.com/v3/exchange/accounts": "fetchBalance",
		"https://api.blockchain.com/v3/exchange/deposits": "fetchDeposits",
		"https://api.blockchain.com/v3/exchange/withdrawals": "fetchWithdrawals",
		"https://api.blockchain.com/v3/exchange/deposits/USDT":
			"fetchDepositAddress",
	},
	hyperliquid: {
		"https://api.hyperliquid.xyz/exchange": "withdraw",
		"https://api.hyperliquid.xyz/info": "fetchWithdrawals",
	},
	digifinex: {
		"https://openapi.digifinex.com/v3/spot/assets": "fetchBalance",
		"https://openapi.digifinex.com/swap/v2/account/balance": "fetchBalance",
		"https://openapi.digifinex.com/v3/deposit/history": "fetchDeposits",
		"https://openapi.digifinex.com/v3/withdraw/history": "fetchWithdrawals",
		"https://openapi.digifinex.com/v3/deposit/address": "fetchDepositAddress",
	},
	kucoinfutures: {
		"https://api-futures.kucoin.com/api/v1/account-overview": "fetchBalance",
		"https://api-futures.kucoin.com/api/v1/deposit-list": "fetchDeposits",
		"https://api-futures.kucoin.com/api/v1/withdrawal-list": "fetchWithdrawals",
		"https://api-futures.kucoin.com/api/v1/deposit-address":
			"fetchDepositAddress",
		"https://api-futures.kucoin.com/api/v1/funding-history":
			"fetchFundingHistory",
	},
	bigone: {
		"https://big.one/api/v3/viewer/accounts": "fetchBalance",
		"https://big.one/api/v3/viewer/deposits": "fetchDeposits",
		"https://big.one/api/v3/viewer/withdrawals": "withdraw",
		"https://big.one/api/v3/viewer/assets/USDT/address": "fetchDepositAddress",
	},
	zonda: {
		"https://api.zondacrypto.exchange/rest/balances/BITBAY/balance":
			"fetchBalance",
	},
	mexc: {
		"https://api.mexc.com/api/v3/account": "fetchBalance",
		"https://contract.mexc.com/api/v1/private/account/assets": "fetchBalance",
		"https://contract.mexc.com/api/v3/margin/isolated/account": "fetchBalance",
		"https://api.mexc.com/api/v3/capital/deposit/hisrec": "fetchDeposits",
		"https://api.mexc.com/api/v3/capital/withdraw/history": "fetchWithdrawals",
		"https://api.mexc.com/api/v3/capital/withdraw": "withdraw",
		"https://api.mexc.com/api/v3/uid": "fetchAccountId",
	},
	onetrading: {
		"https://api.onetrading.com/fast/v1/account/balances": "fetchBalance",
	},
	bitmart: {
		"https://api-cloud.bitmart.com/spot/v1/wallet": "fetchBalance",
		"https://api-cloud-v2.bitmart.com/contract/private/assets-detail":
			"fetchBalance",
		"https://api-cloud-v2.bitmart.com/account/v1/wallet": "fetchBalance",
		"https://api-cloud.bitmart.com/spot/v1/margin/isolated/account":
			"fetchBalance",
		"https://api-cloud-v2.bitmart.com/account/v2/deposit-withdraw/history":
			"fetchWithdrawals",
		"https://api-cloud.bitmart.com/account/v2/deposit-withdraw/history":
			"fetchDeposits",
		"https://api-cloud.bitmart.com/account/v1/deposit/address":
			"fetchDepositAddress",
		"https://api-cloud-v2.bitmart.com/contract/private/transaction-history":
			"fetchFundingHistory",
	},
	coinbase: {
		"https://api.coinbase.com/v2/accounts": "fetchBalance",
	},
	bitrue: {
		"https://www.bitrue.com/api/v1/account": "fetchBalance",
		"https://fapi.bitrue.com/fapi/v2/account": "fetchBalance",
		"https://www.bitrue.com/api/v1/withdraw/history": "fetchWithdrawals",
	},
	independentreserve: {
		"https://api.independentreserve.com/Private/GetDigitalCurrencyDepositAddress":
			"fetchDepositAddress",
		"https://api.independentreserve.com/Private/WithdrawDigitalCurrency":
			"withdraw",
	},
	bitteam: {
		"https://bit.team/trade/api/ccxt/balance": "fetchBalance",
	},
	indodax: {
		"https://indodax.com/tapi": "fetchDepositAddresses",
	},
	woofipro: {
		"https://api-evm.orderly.org/v1/client/holding": "fetchBalance",
	},
	hollaex: {
		"https://api.sandbox.hollaex.com/v2/user/deposits": "fetchDeposits",
		"https://api.sandbox.hollaex.com/v2/user/withdrawals": "fetchWithdrawals",
		"https://api.sandbox.hollaex.com/v2/user": "fetchDepositAddresses",
	},
	bitfinex: {
		"https://api.bitfinex.com/v2/auth/r/wallets": "fetchBalance",
		"https://api.bitfinex.com/v2/auth/w/deposit/address": "fetchDepositAddress",
	},
	bitvavo: {
		"https://api.bitvavo.com/v2/depositHistory": "fetchDeposits",
		"https://api.bitvavo.com/v2/withdrawalHistory": "fetchWithdrawals",
		"https://api.bitvavo.com/v2/balance": "fetchBalance",
	},
	okx: {
		"https://www.okx.com/api/v5/asset/balances": "fetchBalance",
		"https://www.okx.com/api/v5/account/balance": "fetchBalance",
		"https://www.okx.com/api/v5/asset/deposit-history": "fetchDeposits",
		"https://www.okx.com/api/v5/asset/deposit-address": "fetchDepositAddress",
		"https://www.okx.com/api/v5/asset/withdrawal-history": "fetchWithdrawals",
		"https://www.okx.com/api/v5/asset/withdrawal": "withdraw",
	},
	delta: {
		"https://api.delta.exchange/v2/deposits/address": "fetchDepositAddress",
	},
	upbit: {
		"https://api.upbit.com/v1/withdraws/coin": "withdraw",
		"https://api.upbit.com/v1/withdraws/krw": "withdraw",
		"https://sg-api.upbit.com/v1/withdraw": "fetchWithdrawal",
	},
	tokocrypto: {
		"https://www.tokocrypto.com/open/v1/account/spot": "fetchBalance",
		"https://www.tokocrypto.com/open/v1/deposits": "fetchDeposits",
		"https://www.tokocrypto.com/open/v1/withdraws": "fetchWithdrawals",
	},
	wavesexchange: {
		"https://nodes.wx.network/transactions/broadcast": "withdraw",
	},
	coincatch: {
		"https://api.coincatch.com/api/spot/v1/account/assets": "fetchBalance",
		"https://api.coincatch.com/api/mix/v1/account/accounts": "fetchBalance",
		"https://api.coincatch.com/api/spot/v1/wallet/deposit-address":
			"fetchDepositAddress",
		"https://api.coincatch.com/api/spot/v1/wallet/deposit-list":
			"fetchDeposits",
	},
	coinmetro: {
		"https://api.coinmetro.com/users/wallets": "fetchBalance",
	},
	exmo: {
		"https://api.exmo.com/v1.1/wallet_operations": "fetchWithdrawal",
		"https://api.exmo.com/v1.1/user_info": "fetchBalance",
		"https://api.exmo.com/v1.1/deposit_address": "fetchDepositAddress",
	},
	whitebit: {
		"https://whitebit.com/api/v4/trade-account/balance": "fetchBalance",
		"https://whitebit.com/api/v4/main-account/balance": "fetchBalance",
		"https://whitebit.com/api/v4/collateral-account/balance": "fetchBalance",
		"https://whitebit.com/api/v4/main-account/fiat-deposit-url":
			"fetchDepositAddress",
		"https://whitebit.com/api/v4/main-account/address": "fetchDepositAddress",
	},
	ndax: {
		"https://api.ndax.io:8443/AP/GetAccountPositions": "fetchBalance",
		"https://api.ndax.io:8443/AP/GetDepositInfo": "fetchDepositAddress",
		"https://api.ndax.io:8443/AP/GetDeposits": "fetchDeposits",
	},
	blofin: {
		"https://openapi.blofin.com/api/v1/asset/deposit-history": "fetchDeposits",
		"https://openapi.blofin.com/api/v1/asset/withdrawal-history":
			"fetchWithdrawals",
		"https://openapi.blofin.com/api/v1/asset/balances": "fetchBalance",
		"https://openapi.blofin.com/api/v1/account/balance": "fetchBalance",
	},
	bingx: {
		"https://open-api.bingx.com/openApi/wallets/v1/capital/withdraw/apply":
			"withdraw",
		"https://open-api.bingx.com/openApi/spot/v1/account/balance":
			"fetchBalance",
		"https://open-api.bingx.com/openApi/swap/v2/user/balance": "fetchBalance",
		"https://open-api.bingx.com/openApi/cswap/v1/user/balance": "fetchBalance",
		"https://open-api.bingx.com/openApi/api/v3/capital/deposit/hisrec":
			"fetchDeposits",
		"https://open-api.bingx.com/openApi/api/v3/capital/withdraw/history":
			"fetchWithdrawals",
		"https://open-api.bingx.com/openApi/wallets/v1/capital/deposit/address":
			"fetchDepositAddressesByNetwork",
	},
	xt: {
		"https://sapi.xt.com/v4/balances": "fetchBalance",
		"https://fapi.xt.com/future/user/v1/balance/list": "fetchBalance",
		"https://sapi.xt.com/v4/deposit/history": "fetchDeposits",
	},
	okcoin: {
		"https://www.okcoin.com/api/v5/account/balance": "fetchBalance",
		"https://www.okcoin.com/api/v5/asset/deposit-history": "fetchDeposits",
		"https://www.okcoin.com/api/v5/asset/withdrawal-history":
			"fetchWithdrawals",
	},
	derive: {
		"https://api-demo.lyra.finance/private/get_funding_history":
			"fetchFundingHistory",
		"https://api-demo.lyra.finance/private/get_all_portfolios": "fetchBalance",
		"https://api-demo.lyra.finance/private/get_deposit_history":
			"fetchDeposits",
		"https://api-demo.lyra.finance/private/get_withdrawal_history":
			"fetchWithdrawals",
	},
	lbank2: {
		"https://api.lbank.info/v2/get_deposit_address.do": "fetchDepositAddress",
		"https://api.lbank.info/v2/supplement/get_deposit_address.do":
			"fetchDepositAddress",
	},
	kucoin: {
		"https://api.kucoin.com/api/v1/margin/account": "fetchBalance",
		"https://api.kucoin.com/api/v1/deposits": "fetchDeposits",
		"https://api.kucoin.com/api/v1/withdrawals": "fetchWithdrawals",
		"https://api.kucoin.com/api/v3/withdrawals": "withdraw",
		"https://api.kucoin.com/api/v2/deposit-addresses":
			"fetchDepositAddressesByNetwork",
	},
	timex: {
		"https://plasma-relay-backend.timex.io/trading/balances": "fetchBalance",
		"https://plasma-relay-backend.timex.io/currencies/s/BTC":
			"fetchDepositAddress",
	},
	coinbasepro: {
		"https://api.pro.coinbase.com/accounts": "fetchBalance",
		"https://api.pro.coinbase.com/transfers": "fetchWithdrawals",
	},
	paradex: {
		"https://api.testnet.paradex.trade/v1/balance": "fetchBalance",
		"https://api.testnet.paradex.trade/v1/transfers": "fetchWithdrawals",
	},
	binance: {
		"https://api.binance.com/api/v3/account": "fetchBalance",
		"https://testnet.binancefuture.com/sapi/v1/margin/account": "fetchBalance",
		"https://testnet.binancefuture.com/sapi/v1/lending/union/account":
			"fetchBalance",
		"https://testnet.binancefuture.com/sapi/v1/asset/get-funding-asset":
			"fetchBalance",
		"https://api.binance.com/sapi/v1/margin/isolated/account": "fetchBalance",
		"https://api.binance.com/api/v5/user/query-api": "fetchAccountId",
		"https://papi.binance.com/papi/v1/balance": "fetchBalance",
		"https://api.binance.com/sapi/v1/capital/deposit/hisrec": "fetchDeposits",
		"https://api.binance.com/sapi/v1/fiat/orders": "fetchDeposits",
		"https://papi.binance.com/papi/v1/um/income": "fetchFundingHistory",
		"https://papi.binance.com/papi/v1/cm/income": "fetchFundingHistory",
		"https://api.binance.com/fapi/v1/income": "fetchFundingHistory",
		"https://api.binance.com/dapi/v1/income": "fetchFundingHistory",
		"https://api.binance.com/sapi/v1/capital/withdraw/history":
			"fetchWithdrawals",
		"https://api.binance.com/sapi/v1/capital/withdraw/apply": "withdraw",
		"https://api.binance.com/sapi/v1/capital/deposit/address":
			"fetchDepositAddress",
	},
	poloniex: {
		"https://api.poloniex.com/wallets/withdraw": "withdraw",
		"https://api.poloniex.com/wallets/addresses": "fetchDepositAddress",
		"https://api.poloniex.com/v3/account/balance": "fetchBalance",
		"https://api.poloniex.com/accounts/balances": "fetchBalance",
		"https://api.poloniex.com/wallets/activity": "fetchWithdrawals",
	},
	bithumb: {
		"https://api.bithumb.com/info/balance": "fetchBalance",
	},
	bitget: {
		"https://api.bitget.com/api/v2/spot/wallet/withdrawal": "withdraw",
		"https://api.bitget.com/api/v2/spot/account/assets": "fetchBalance",
		"https://api.bitget.com/api/v2/mix/account/accounts": "fetchBalance",
		"https://api.bitget.com/api/margin/v1/cross/account/assets": "fetchBalance",
		"https://api.bitget.com/api/margin/v1/isolated/account/assets":
			"fetchBalance",
		"https://api.bitget.com/api/v2/mix/account/bill": "fetchFundingHistory",
		"https://api.bitget.com/api/v2/spot/wallet/deposit-address":
			"fetchDepositAddress",
		"https://api.bitget.com/api/v2/spot/wallet/deposit-records":
			"fetchDeposits",
		"https://api.bitget.com/api/v2/spot/wallet/withdrawal-records":
			"fetchWithdrawals",
	},
	deribit: {
		"https://www.deribit.com/api/v2/private/get_account_summaries":
			"fetchBalance",
		"https://www.deribit.com/api/v2/private/get_account_summary":
			"fetchBalance",
		"https://test.deribit.com/api/v2/private/get_current_deposit_address":
			"fetchDepositAddress",
		"https://test.deribit.com/api/v2/private/get_deposits": "fetchDeposits",
		"https://test.deribit.com/api/v2/private/get_withdrawals":
			"fetchWithdrawals",
	},
	bitso: {
		"https://bitso.com/api/v3/balance": "fetchBalance",
		"https://bitso.com/api/v3/fundings": "fetchDeposits",
	},
	defx: {
		"https://api.defx.com/v1/auth/api/wallet/balance": "fetchBalance",
		"https://api.defx.com/v1/auth/api/transfers/bridge/withdrawal": "withdraw",
	},
	bybit: {
		"https://api-testnet.bybit.com/v5/execution/list": "fetchFundingHistory",
		"https://api-testnet.bybit.com/v5/account/wallet-balance": "fetchBalance",
		"https://api.bybit.com/v5/asset/transfer/query-account-coins-balance":
			"fetchBalance",
		"https://api.bybit.com/v5/account/wallet-balance": "fetchBalance",
		"https://api-testnet.bybit.com/v5/asset/deposit/query-record":
			"fetchDeposits",
		"https://api.bybit.com/v5/account/withdrawal": "withdraw",
		"https://api-testnet.bybit.com/v5/account/withdrawal": "withdraw",
		"https://api.bybit.com/v5/asset/withdraw/create": "withdraw",
		"https://api-testnet.bybit.com/v5/asset/deposit/query-address":
			"fetchDepositAddressesByNetwork",
		"https://api.bybit.com/v5/asset/deposit/query-address":
			"fetchDepositAddressesByNetwork",
		"https://api.bybit.com/v5/user/query-api": "fetchAccountId",
		"https://api-testnet.bybit.com/v5/user/query-api": "fetchAccountId",
	},
	cryptomus: {
		"https://api.cryptomus.com/v2/user-api/exchange/account/balance":
			"fetchBalance",
	},
	phemex: {
		"https://api.phemex.com/spot/wallets": "fetchBalance",
		"https://api.phemex.com/exchange/wallets/depositList": "fetchDeposits",
		"https://api.phemex.com/exchange/wallets/withdrawList": "fetchWithdrawals",
		"https://testnet-api.phemex.com/exchange/wallets/v2/depositAddress":
			"fetchDepositAddress",
		"https://api.phemex.com/phemex-withdraw/wallets/api/createWithdraw":
			"withdraw",
	},
	oceanex: {
		"https://api.oceanex.pro/v1/members/me": "fetchBalance",
		"https://api.oceanex.pro/v1//deposit_addresses":
			"fetchDepositAddressesByNetwork",
	},
	cryptocom: {
		"https://api.crypto.com/exchange/v1/private/user-balance": "fetchBalance",
		"https://api.crypto.com/exchange/v1/private/get-deposit-history":
			"fetchDeposits",
		"https://api.crypto.com/exchange/v1/private/get-withdrawal-history":
			"fetchWithdrawals",
		"https://api.crypto.com/exchange/v1/private/get-deposit-address":
			"fetchDepositAddress",
	},
	cex: {
		"https://trade.cex.io/api/spot/rest/get_my_wallet_balance": "fetchBalance",
		"https://trade.cex.io/api/spot/rest/get_deposit_address":
			"fetchDepositAddress",
	},
	latoken: {
		"https://api.latoken.com/v2/auth/account": "fetchBalance",
	},
	hashkey: {
		"https://api-glb.hashkey.com/api/v1/account/trades": "fetchMyTrades",
		"https://api-glb.hashkey.com/api/v1/account": "fetchBalance",
		"https://api-glb.hashkey.com/api/v1/futures/balance": "fetchBalance",
		"https://api-glb.hashkey.com/api/v1/account/deposit/address":
			"fetchDepositAddress",
		"https://api-glb.hashkey.com/api/v1/account/depositOrders": "fetchDeposits",
		"https://api-glb.hashkey.com/api/v1/account/withdrawOrders":
			"fetchWithdrawals",
	},
	bitstamp: {
		"https://www.bitstamp.net/api/v2/account_balances/": "fetchBalance",
		"https://www.bitstamp.net/api/v2/usdt_address/": "fetchDepositAddress",
	},
	modetrade: {
		"https://api-evm.orderly.org/v1/client/holding": "fetchBalance",
	},
	oxfun: {
		"https://api.ox.fun/v3/funding/estimates": "fetchFundingRates",
		"https://api.ox.fun/v3/funding/rates": "fetchFundingRateHistory",
		"https://api.ox.fun/v3/funding": "fetchFundingHistory",
		"https://api.ox.fun/v3/balances": "fetchBalance",
		"https://api.ox.fun/v3/deposit-addresses": "fetchDepositAddress",
		"https://api.ox.fun/v3/deposit": "fetchDeposits",
		"https://api.ox.fun/v3/withdrawal": "fetchWithdrawals",
	},
	coinex: {
		"https://api.coinex.com/v2/assets/spot/balance": "fetchBalance",
		"https://api.coinex.com/v2/assets/futures/balance": "fetchBalance",
		"https://api.coinex.com/v2/assets/financial/balance": "fetchBalance",
		"https://api.coinex.com/v2/assets/margin/balance": "fetchBalance",
		"https://api.coinex.com/v2/assets/deposit-history": "fetchDeposits",
		"https://api.coinex.com/v2/assets/withdraw": "withdraw",
		"https://api.coinex.com/v2/assets/deposit-address": "fetchDepositAddress",
		"https://api.coinex.com/v2/futures/position-funding-history":
			"fetchFundingHistory",
	},
	woo: {
		"https://api.woox.io/v1/asset/withdraw": "withdraw",
		"https://api.woox.io/v3/balances": "fetchBalance",
		"https://api.woox.io/v1/asset/deposit": "fetchDepositAddress",
		"https://api.woox.io/v1/funding_fee/history": "fetchFundingHistory",
	},
	huobi: {
		"https://api.huobi.pro/v1/query/deposit-withdraw": "fetchWithdrawals",
		"https://api.huobi.pro/v2/account/deposit/address": "fetchDepositAddress",
		"https://api.hbdm.com/linear-swap-api/v3/swap_financial_record_exact":
			"fetchFundingHistory",
		"https://api.hbdm.com/swap-api/v3/swap_financial_record_exact":
			"fetchFundingHistory",
		"https://api.hbdm.com/api/v3/contract_financial_record_exact":
			"fetchFundingHistory",
	},
	btcalpha: {
		"https://btc-alpha.com/api/v1/wallets/": "fetchBalance",
		"https://btc-alpha.com/api/v1/deposits/": "fetchDeposits",
		"https://btc-alpha.com/api/v1/withdraws/": "fetchWithdrawals",
	},
	kraken: {
		"https://api.kraken.com/0/private/BalanceEx": "fetchBalance",
		"https://api.kraken.com/0/private/DepositStatus": "fetchDeposits",
		"https://api.kraken.com/0/private/WithdrawStatus": "fetchWithdrawals",
		"https://api.kraken.com/0/private/DepositAddresses": "fetchDepositAddress",
	},
	p2b: {
		"https://api.p2pb2b.com/api/v2/account/balances": "fetchBalance",
	},
	ellipx: {
		"https://app.ellipx.com/_rest/User/Wallet": "fetchBalance",
	},
	ascendex: {
		"https://ascendex.com/myAccount/api/pro/v1/cash/balance": "fetchBalance",
		"https://ascendex.com/myAccount/api/pro/v1/margin/balance": "fetchBalance",
		"https://ascendex.com/api/pro/v1/wallet/deposit/address":
			"fetchDepositAddress",
		"https://ascendex.com/myAccount/api/pro/v2/futures/funding-payments":
			"fetchFundingHistory",
	},
	coinsph: {
		"https://api.pro.coins.ph/openapi/v1/account": "fetchBalance",
		"https://api.pro.coins.ph/openapi/wallet/v1/deposit/history":
			"fetchDeposits",
		"https://api.pro.coins.ph/openapi/wallet/v1/withdraw/history":
			"fetchWithdrawals",
	},
	alpaca: {
		"https://api.alpaca.markets/v2/account/activities/FILL": "fetchMyTrades",
		"https://api.alpaca.markets/v2/wallets": "fetchDepositAddress",
		"https://api.alpaca.markets/v2/wallets/transfers": "withdraw",
		"https://api.alpaca.markets/v2/account": "fetchBalance",
	},
	tradeogre: {
		"https://tradeogre.com/api/v1/account/balance": "fetchBalance",
		"https://tradeogre.com/api/v1/account/balances": "fetchBalance",
	},
	bequant: {
		"https://api.bequant.io/api/3/spot/balance": "fetchBalance",
		"https://api.bequant.io/api/3/wallet/transactions": "fetchWithdrawals",
	},
	binanceus: {
		"https://api.binance.us/api/v3/account": "fetchBalance",
		"https://api.binance.us/sapi/v1/capital/deposit/hisrec": "fetchDeposits",
	},
};
