// Original file: proto/node.proto


export interface DepositConfirmationRequest {
  'chain'?: (string);
  'recipientAddress'?: (string);
  'amount'?: (number | string);
  'transactionHash'?: (string);
}

export interface DepositConfirmationRequest__Output {
  'chain'?: (string);
  'recipientAddress'?: (string);
  'amount'?: (number);
  'transactionHash'?: (string);
}
