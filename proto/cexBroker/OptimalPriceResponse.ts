// Original file: proto/node.proto

import type { PriceInfo as _cexBroker_PriceInfo, PriceInfo__Output as _cexBroker_PriceInfo__Output } from '../cexBroker/PriceInfo';

export interface OptimalPriceResponse {
  'results'?: ({[key: string]: _cexBroker_PriceInfo});
}

export interface OptimalPriceResponse__Output {
  'results'?: ({[key: string]: _cexBroker_PriceInfo__Output});
}
