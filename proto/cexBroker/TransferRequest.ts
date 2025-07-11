// Original file: proto/node.proto


export interface TransferRequest {
  'chain'?: (string);
  'recipientAddress'?: (string);
  'amount'?: (number | string);
  'cex'?: (string);
  'token'?: (string);
}

export interface TransferRequest__Output {
  'chain'?: (string);
  'recipientAddress'?: (string);
  'amount'?: (number);
  'cex'?: (string);
  'token'?: (string);
}
