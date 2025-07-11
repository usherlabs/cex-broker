// Original file: proto/node.proto

import type { OrderMode as _cexBroker_OrderMode, OrderMode__Output as _cexBroker_OrderMode__Output } from '../cexBroker/OrderMode';

export interface OptimalPriceRequest {
  'symbol'?: (string);
  'quantity'?: (number | string);
  'mode'?: (_cexBroker_OrderMode);
}

export interface OptimalPriceRequest__Output {
  'symbol'?: (string);
  'quantity'?: (number);
  'mode'?: (_cexBroker_OrderMode__Output);
}
