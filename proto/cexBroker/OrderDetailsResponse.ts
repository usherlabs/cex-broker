// Original file: proto/node.proto


export interface OrderDetailsResponse {
  'orderId'?: (string);
  'status'?: (string);
  'originalAmount'?: (number | string);
  'filledAmount'?: (number | string);
  'symbol'?: (string);
  'mode'?: (string);
  'price'?: (number | string);
}

export interface OrderDetailsResponse__Output {
  'orderId'?: (string);
  'status'?: (string);
  'originalAmount'?: (number);
  'filledAmount'?: (number);
  'symbol'?: (string);
  'mode'?: (string);
  'price'?: (number);
}
