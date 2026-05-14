// Auto-generated from src/proto/node.proto. Do not edit manually.
const descriptor = {
	nested: {
		cex_broker: {
			nested: {
				ActionRequest: {
					fields: {
						action: {
							type: "Action",
							id: 1,
						},
						payload: {
							keyType: "string",
							type: "string",
							id: 2,
						},
						cex: {
							type: "string",
							id: 3,
						},
						symbol: {
							type: "string",
							id: 4,
						},
					},
				},
				ActionResponse: {
					fields: {
						result: {
							type: "string",
							id: 1,
						},
						proof: {
							type: "string",
							id: 2,
						},
					},
				},
				SubscribeRequest: {
					fields: {
						cex: {
							type: "string",
							id: 1,
						},
						symbol: {
							type: "string",
							id: 2,
						},
						type: {
							type: "SubscriptionType",
							id: 3,
						},
						options: {
							keyType: "string",
							type: "string",
							id: 4,
						},
					},
				},
				SubscribeResponse: {
					fields: {
						data: {
							type: "string",
							id: 1,
						},
						timestamp: {
							type: "int64",
							id: 2,
						},
						symbol: {
							type: "string",
							id: 3,
						},
						type: {
							type: "SubscriptionType",
							id: 4,
						},
					},
				},
				SubscriptionType: {
					values: {
						NO_ACTION: 0,
						ORDERBOOK: 1,
						TRADES: 2,
						TICKER: 3,
						OHLCV: 4,
						BALANCE: 5,
						ORDERS: 6,
					},
				},
				cex_service: {
					methods: {
						ExecuteAction: {
							requestType: "ActionRequest",
							responseType: "ActionResponse",
						},
						Subscribe: {
							requestType: "SubscribeRequest",
							responseType: "SubscribeResponse",
							responseStream: true,
						},
					},
				},
				Action: {
					values: {
						NoAction: 0,
						Deposit: 1,
						Withdraw: 2,
						CreateOrder: 3,
						GetOrderDetails: 4,
						CancelOrder: 5,
						FetchBalances: 6,
						FetchDepositAddresses: 7,
						FetchTicker: 8,
						FetchCurrency: 9,
						Call: 10,
						FetchAccountId: 11,
						FetchFees: 12,
						InternalTransfer: 13,
					},
				},
			},
		},
	},
} as const;

export default descriptor;
