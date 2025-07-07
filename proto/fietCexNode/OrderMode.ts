// Original file: proto/node.proto

export const OrderMode = {
  BUY: 0,
  SELL: 1,
} as const;

export type OrderMode =
  | 'BUY'
  | 0
  | 'SELL'
  | 1

export type OrderMode__Output = typeof OrderMode[keyof typeof OrderMode]
