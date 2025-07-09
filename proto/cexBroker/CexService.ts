// Original file: proto/node.proto

import type * as grpc from '@grpc/grpc-js'
import type { MethodDefinition } from '@grpc/proto-loader'
import type { BalanceRequest as _cexBroker_BalanceRequest, BalanceRequest__Output as _cexBroker_BalanceRequest__Output } from '../cexBroker/BalanceRequest';
import type { BalanceResponse as _cexBroker_BalanceResponse, BalanceResponse__Output as _cexBroker_BalanceResponse__Output } from '../cexBroker/BalanceResponse';
import type { CancelOrderRequest as _cexBroker_CancelOrderRequest, CancelOrderRequest__Output as _cexBroker_CancelOrderRequest__Output } from '../cexBroker/CancelOrderRequest';
import type { CancelOrderResponse as _cexBroker_CancelOrderResponse, CancelOrderResponse__Output as _cexBroker_CancelOrderResponse__Output } from '../cexBroker/CancelOrderResponse';
import type { ConvertRequest as _cexBroker_ConvertRequest, ConvertRequest__Output as _cexBroker_ConvertRequest__Output } from '../cexBroker/ConvertRequest';
import type { ConvertResponse as _cexBroker_ConvertResponse, ConvertResponse__Output as _cexBroker_ConvertResponse__Output } from '../cexBroker/ConvertResponse';
import type { DepositConfirmationRequest as _cexBroker_DepositConfirmationRequest, DepositConfirmationRequest__Output as _cexBroker_DepositConfirmationRequest__Output } from '../cexBroker/DepositConfirmationRequest';
import type { DepositConfirmationResponse as _cexBroker_DepositConfirmationResponse, DepositConfirmationResponse__Output as _cexBroker_DepositConfirmationResponse__Output } from '../cexBroker/DepositConfirmationResponse';
import type { OrderDetailsRequest as _cexBroker_OrderDetailsRequest, OrderDetailsRequest__Output as _cexBroker_OrderDetailsRequest__Output } from '../cexBroker/OrderDetailsRequest';
import type { OrderDetailsResponse as _cexBroker_OrderDetailsResponse, OrderDetailsResponse__Output as _cexBroker_OrderDetailsResponse__Output } from '../cexBroker/OrderDetailsResponse';
import type { TransferRequest as _cexBroker_TransferRequest, TransferRequest__Output as _cexBroker_TransferRequest__Output } from '../cexBroker/TransferRequest';
import type { TransferResponse as _cexBroker_TransferResponse, TransferResponse__Output as _cexBroker_TransferResponse__Output } from '../cexBroker/TransferResponse';

export interface CexServiceClient extends grpc.Client {
  CancelOrder(argument: _cexBroker_CancelOrderRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  CancelOrder(argument: _cexBroker_CancelOrderRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  CancelOrder(argument: _cexBroker_CancelOrderRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  CancelOrder(argument: _cexBroker_CancelOrderRequest, callback: grpc.requestCallback<_cexBroker_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  cancelOrder(argument: _cexBroker_CancelOrderRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  cancelOrder(argument: _cexBroker_CancelOrderRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  cancelOrder(argument: _cexBroker_CancelOrderRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  cancelOrder(argument: _cexBroker_CancelOrderRequest, callback: grpc.requestCallback<_cexBroker_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  
  Convert(argument: _cexBroker_ConvertRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_ConvertResponse__Output>): grpc.ClientUnaryCall;
  Convert(argument: _cexBroker_ConvertRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_ConvertResponse__Output>): grpc.ClientUnaryCall;
  Convert(argument: _cexBroker_ConvertRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_ConvertResponse__Output>): grpc.ClientUnaryCall;
  Convert(argument: _cexBroker_ConvertRequest, callback: grpc.requestCallback<_cexBroker_ConvertResponse__Output>): grpc.ClientUnaryCall;
  convert(argument: _cexBroker_ConvertRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_ConvertResponse__Output>): grpc.ClientUnaryCall;
  convert(argument: _cexBroker_ConvertRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_ConvertResponse__Output>): grpc.ClientUnaryCall;
  convert(argument: _cexBroker_ConvertRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_ConvertResponse__Output>): grpc.ClientUnaryCall;
  convert(argument: _cexBroker_ConvertRequest, callback: grpc.requestCallback<_cexBroker_ConvertResponse__Output>): grpc.ClientUnaryCall;
  
  Deposit(argument: _cexBroker_DepositConfirmationRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  Deposit(argument: _cexBroker_DepositConfirmationRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  Deposit(argument: _cexBroker_DepositConfirmationRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  Deposit(argument: _cexBroker_DepositConfirmationRequest, callback: grpc.requestCallback<_cexBroker_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  deposit(argument: _cexBroker_DepositConfirmationRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  deposit(argument: _cexBroker_DepositConfirmationRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  deposit(argument: _cexBroker_DepositConfirmationRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  deposit(argument: _cexBroker_DepositConfirmationRequest, callback: grpc.requestCallback<_cexBroker_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  
  GetBalance(argument: _cexBroker_BalanceRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_BalanceResponse__Output>): grpc.ClientUnaryCall;
  GetBalance(argument: _cexBroker_BalanceRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_BalanceResponse__Output>): grpc.ClientUnaryCall;
  GetBalance(argument: _cexBroker_BalanceRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_BalanceResponse__Output>): grpc.ClientUnaryCall;
  GetBalance(argument: _cexBroker_BalanceRequest, callback: grpc.requestCallback<_cexBroker_BalanceResponse__Output>): grpc.ClientUnaryCall;
  getBalance(argument: _cexBroker_BalanceRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_BalanceResponse__Output>): grpc.ClientUnaryCall;
  getBalance(argument: _cexBroker_BalanceRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_BalanceResponse__Output>): grpc.ClientUnaryCall;
  getBalance(argument: _cexBroker_BalanceRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_BalanceResponse__Output>): grpc.ClientUnaryCall;
  getBalance(argument: _cexBroker_BalanceRequest, callback: grpc.requestCallback<_cexBroker_BalanceResponse__Output>): grpc.ClientUnaryCall;
  
  GetOrderDetails(argument: _cexBroker_OrderDetailsRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  GetOrderDetails(argument: _cexBroker_OrderDetailsRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  GetOrderDetails(argument: _cexBroker_OrderDetailsRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  GetOrderDetails(argument: _cexBroker_OrderDetailsRequest, callback: grpc.requestCallback<_cexBroker_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  getOrderDetails(argument: _cexBroker_OrderDetailsRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  getOrderDetails(argument: _cexBroker_OrderDetailsRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  getOrderDetails(argument: _cexBroker_OrderDetailsRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  getOrderDetails(argument: _cexBroker_OrderDetailsRequest, callback: grpc.requestCallback<_cexBroker_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  
  Transfer(argument: _cexBroker_TransferRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_TransferResponse__Output>): grpc.ClientUnaryCall;
  Transfer(argument: _cexBroker_TransferRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_TransferResponse__Output>): grpc.ClientUnaryCall;
  Transfer(argument: _cexBroker_TransferRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_TransferResponse__Output>): grpc.ClientUnaryCall;
  Transfer(argument: _cexBroker_TransferRequest, callback: grpc.requestCallback<_cexBroker_TransferResponse__Output>): grpc.ClientUnaryCall;
  transfer(argument: _cexBroker_TransferRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_TransferResponse__Output>): grpc.ClientUnaryCall;
  transfer(argument: _cexBroker_TransferRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_TransferResponse__Output>): grpc.ClientUnaryCall;
  transfer(argument: _cexBroker_TransferRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_TransferResponse__Output>): grpc.ClientUnaryCall;
  transfer(argument: _cexBroker_TransferRequest, callback: grpc.requestCallback<_cexBroker_TransferResponse__Output>): grpc.ClientUnaryCall;
  
}

export interface CexServiceHandlers extends grpc.UntypedServiceImplementation {
  CancelOrder: grpc.handleUnaryCall<_cexBroker_CancelOrderRequest__Output, _cexBroker_CancelOrderResponse>;
  
  Convert: grpc.handleUnaryCall<_cexBroker_ConvertRequest__Output, _cexBroker_ConvertResponse>;
  
  Deposit: grpc.handleUnaryCall<_cexBroker_DepositConfirmationRequest__Output, _cexBroker_DepositConfirmationResponse>;
  
  GetBalance: grpc.handleUnaryCall<_cexBroker_BalanceRequest__Output, _cexBroker_BalanceResponse>;
  
  GetOrderDetails: grpc.handleUnaryCall<_cexBroker_OrderDetailsRequest__Output, _cexBroker_OrderDetailsResponse>;
  
  Transfer: grpc.handleUnaryCall<_cexBroker_TransferRequest__Output, _cexBroker_TransferResponse>;
  
}

export interface CexServiceDefinition extends grpc.ServiceDefinition {
  CancelOrder: MethodDefinition<_cexBroker_CancelOrderRequest, _cexBroker_CancelOrderResponse, _cexBroker_CancelOrderRequest__Output, _cexBroker_CancelOrderResponse__Output>
  Convert: MethodDefinition<_cexBroker_ConvertRequest, _cexBroker_ConvertResponse, _cexBroker_ConvertRequest__Output, _cexBroker_ConvertResponse__Output>
  Deposit: MethodDefinition<_cexBroker_DepositConfirmationRequest, _cexBroker_DepositConfirmationResponse, _cexBroker_DepositConfirmationRequest__Output, _cexBroker_DepositConfirmationResponse__Output>
  GetBalance: MethodDefinition<_cexBroker_BalanceRequest, _cexBroker_BalanceResponse, _cexBroker_BalanceRequest__Output, _cexBroker_BalanceResponse__Output>
  GetOrderDetails: MethodDefinition<_cexBroker_OrderDetailsRequest, _cexBroker_OrderDetailsResponse, _cexBroker_OrderDetailsRequest__Output, _cexBroker_OrderDetailsResponse__Output>
  Transfer: MethodDefinition<_cexBroker_TransferRequest, _cexBroker_TransferResponse, _cexBroker_TransferRequest__Output, _cexBroker_TransferResponse__Output>
}
