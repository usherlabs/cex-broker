// Original file: proto/node.proto

import type { Action as _cexBroker_Action, Action__Output as _cexBroker_Action__Output } from '../cexBroker/Action';

export interface CcxtActionRequest {
  'action'?: (_cexBroker_Action);
  'payload'?: ({[key: string]: string});
  'cex'?: (string);
  'symbol'?: (string);
}

export interface CcxtActionRequest__Output {
  'action'?: (_cexBroker_Action__Output);
  'payload'?: ({[key: string]: string});
  'cex'?: (string);
  'symbol'?: (string);
}
