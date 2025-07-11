// Original file: proto/node.proto


export interface ConvertRequest {
  'fromToken'?: (string);
  'toToken'?: (string);
  'amount'?: (number | string);
  'price'?: (number | string);
  'cex'?: (string);
}

export interface ConvertRequest__Output {
  'fromToken'?: (string);
  'toToken'?: (string);
  'amount'?: (number);
  'price'?: (number);
  'cex'?: (string);
}
