// Original file: proto/node.proto

export const Action = {
  NoAction: 0,
  Deposit: 1,
  Transfer: 2,
  CreateOrder: 3,
  GetOrderDetails: 4,
  CancelOrder: 5,
  FetchBalance: 6,
} as const;

export type Action =
  | 'NoAction'
  | 0
  | 'Deposit'
  | 1
  | 'Transfer'
  | 2
  | 'CreateOrder'
  | 3
  | 'GetOrderDetails'
  | 4
  | 'CancelOrder'
  | 5
  | 'FetchBalance'
  | 6

export type Action__Output = typeof Action[keyof typeof Action]
