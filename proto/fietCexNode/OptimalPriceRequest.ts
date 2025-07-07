// Original file: proto/node.proto

import type { OrderMode as _fietCexNode_OrderMode, OrderMode__Output as _fietCexNode_OrderMode__Output } from '../fietCexNode/OrderMode';

export interface OptimalPriceRequest {
  'symbol'?: (string);
  'quantity'?: (number | string);
  'mode'?: (_fietCexNode_OrderMode);
}

export interface OptimalPriceRequest__Output {
  'symbol'?: (string);
  'quantity'?: (number);
  'mode'?: (_fietCexNode_OrderMode__Output);
}
