// Original file: proto/node.proto

import type * as grpc from '@grpc/grpc-js'
import type { MethodDefinition } from '@grpc/proto-loader'
import type { BalanceRequest as _fietCexNode_BalanceRequest, BalanceRequest__Output as _fietCexNode_BalanceRequest__Output } from '../fietCexNode/BalanceRequest';
import type { BalanceResponse as _fietCexNode_BalanceResponse, BalanceResponse__Output as _fietCexNode_BalanceResponse__Output } from '../fietCexNode/BalanceResponse';
import type { CancelOrderRequest as _fietCexNode_CancelOrderRequest, CancelOrderRequest__Output as _fietCexNode_CancelOrderRequest__Output } from '../fietCexNode/CancelOrderRequest';
import type { CancelOrderResponse as _fietCexNode_CancelOrderResponse, CancelOrderResponse__Output as _fietCexNode_CancelOrderResponse__Output } from '../fietCexNode/CancelOrderResponse';
import type { ConvertRequest as _fietCexNode_ConvertRequest, ConvertRequest__Output as _fietCexNode_ConvertRequest__Output } from '../fietCexNode/ConvertRequest';
import type { ConvertResponse as _fietCexNode_ConvertResponse, ConvertResponse__Output as _fietCexNode_ConvertResponse__Output } from '../fietCexNode/ConvertResponse';
import type { DepositConfirmationRequest as _fietCexNode_DepositConfirmationRequest, DepositConfirmationRequest__Output as _fietCexNode_DepositConfirmationRequest__Output } from '../fietCexNode/DepositConfirmationRequest';
import type { DepositConfirmationResponse as _fietCexNode_DepositConfirmationResponse, DepositConfirmationResponse__Output as _fietCexNode_DepositConfirmationResponse__Output } from '../fietCexNode/DepositConfirmationResponse';
import type { OptimalPriceRequest as _fietCexNode_OptimalPriceRequest, OptimalPriceRequest__Output as _fietCexNode_OptimalPriceRequest__Output } from '../fietCexNode/OptimalPriceRequest';
import type { OptimalPriceResponse as _fietCexNode_OptimalPriceResponse, OptimalPriceResponse__Output as _fietCexNode_OptimalPriceResponse__Output } from '../fietCexNode/OptimalPriceResponse';
import type { OrderDetailsRequest as _fietCexNode_OrderDetailsRequest, OrderDetailsRequest__Output as _fietCexNode_OrderDetailsRequest__Output } from '../fietCexNode/OrderDetailsRequest';
import type { OrderDetailsResponse as _fietCexNode_OrderDetailsResponse, OrderDetailsResponse__Output as _fietCexNode_OrderDetailsResponse__Output } from '../fietCexNode/OrderDetailsResponse';
import type { TransferRequest as _fietCexNode_TransferRequest, TransferRequest__Output as _fietCexNode_TransferRequest__Output } from '../fietCexNode/TransferRequest';
import type { TransferResponse as _fietCexNode_TransferResponse, TransferResponse__Output as _fietCexNode_TransferResponse__Output } from '../fietCexNode/TransferResponse';

export interface CexServiceClient extends grpc.Client {
  CancelOrder(argument: _fietCexNode_CancelOrderRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  CancelOrder(argument: _fietCexNode_CancelOrderRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  CancelOrder(argument: _fietCexNode_CancelOrderRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  CancelOrder(argument: _fietCexNode_CancelOrderRequest, callback: grpc.requestCallback<_fietCexNode_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  cancelOrder(argument: _fietCexNode_CancelOrderRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  cancelOrder(argument: _fietCexNode_CancelOrderRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  cancelOrder(argument: _fietCexNode_CancelOrderRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  cancelOrder(argument: _fietCexNode_CancelOrderRequest, callback: grpc.requestCallback<_fietCexNode_CancelOrderResponse__Output>): grpc.ClientUnaryCall;
  
  Convert(argument: _fietCexNode_ConvertRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_ConvertResponse__Output>): grpc.ClientUnaryCall;
  Convert(argument: _fietCexNode_ConvertRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_ConvertResponse__Output>): grpc.ClientUnaryCall;
  Convert(argument: _fietCexNode_ConvertRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_ConvertResponse__Output>): grpc.ClientUnaryCall;
  Convert(argument: _fietCexNode_ConvertRequest, callback: grpc.requestCallback<_fietCexNode_ConvertResponse__Output>): grpc.ClientUnaryCall;
  convert(argument: _fietCexNode_ConvertRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_ConvertResponse__Output>): grpc.ClientUnaryCall;
  convert(argument: _fietCexNode_ConvertRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_ConvertResponse__Output>): grpc.ClientUnaryCall;
  convert(argument: _fietCexNode_ConvertRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_ConvertResponse__Output>): grpc.ClientUnaryCall;
  convert(argument: _fietCexNode_ConvertRequest, callback: grpc.requestCallback<_fietCexNode_ConvertResponse__Output>): grpc.ClientUnaryCall;
  
  Deposit(argument: _fietCexNode_DepositConfirmationRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  Deposit(argument: _fietCexNode_DepositConfirmationRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  Deposit(argument: _fietCexNode_DepositConfirmationRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  Deposit(argument: _fietCexNode_DepositConfirmationRequest, callback: grpc.requestCallback<_fietCexNode_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  deposit(argument: _fietCexNode_DepositConfirmationRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  deposit(argument: _fietCexNode_DepositConfirmationRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  deposit(argument: _fietCexNode_DepositConfirmationRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  deposit(argument: _fietCexNode_DepositConfirmationRequest, callback: grpc.requestCallback<_fietCexNode_DepositConfirmationResponse__Output>): grpc.ClientUnaryCall;
  
  GetBalance(argument: _fietCexNode_BalanceRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_BalanceResponse__Output>): grpc.ClientUnaryCall;
  GetBalance(argument: _fietCexNode_BalanceRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_BalanceResponse__Output>): grpc.ClientUnaryCall;
  GetBalance(argument: _fietCexNode_BalanceRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_BalanceResponse__Output>): grpc.ClientUnaryCall;
  GetBalance(argument: _fietCexNode_BalanceRequest, callback: grpc.requestCallback<_fietCexNode_BalanceResponse__Output>): grpc.ClientUnaryCall;
  getBalance(argument: _fietCexNode_BalanceRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_BalanceResponse__Output>): grpc.ClientUnaryCall;
  getBalance(argument: _fietCexNode_BalanceRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_BalanceResponse__Output>): grpc.ClientUnaryCall;
  getBalance(argument: _fietCexNode_BalanceRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_BalanceResponse__Output>): grpc.ClientUnaryCall;
  getBalance(argument: _fietCexNode_BalanceRequest, callback: grpc.requestCallback<_fietCexNode_BalanceResponse__Output>): grpc.ClientUnaryCall;
  
  GetOptimalPrice(argument: _fietCexNode_OptimalPriceRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_OptimalPriceResponse__Output>): grpc.ClientUnaryCall;
  GetOptimalPrice(argument: _fietCexNode_OptimalPriceRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_OptimalPriceResponse__Output>): grpc.ClientUnaryCall;
  GetOptimalPrice(argument: _fietCexNode_OptimalPriceRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_OptimalPriceResponse__Output>): grpc.ClientUnaryCall;
  GetOptimalPrice(argument: _fietCexNode_OptimalPriceRequest, callback: grpc.requestCallback<_fietCexNode_OptimalPriceResponse__Output>): grpc.ClientUnaryCall;
  getOptimalPrice(argument: _fietCexNode_OptimalPriceRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_OptimalPriceResponse__Output>): grpc.ClientUnaryCall;
  getOptimalPrice(argument: _fietCexNode_OptimalPriceRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_OptimalPriceResponse__Output>): grpc.ClientUnaryCall;
  getOptimalPrice(argument: _fietCexNode_OptimalPriceRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_OptimalPriceResponse__Output>): grpc.ClientUnaryCall;
  getOptimalPrice(argument: _fietCexNode_OptimalPriceRequest, callback: grpc.requestCallback<_fietCexNode_OptimalPriceResponse__Output>): grpc.ClientUnaryCall;
  
  GetOrderDetails(argument: _fietCexNode_OrderDetailsRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  GetOrderDetails(argument: _fietCexNode_OrderDetailsRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  GetOrderDetails(argument: _fietCexNode_OrderDetailsRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  GetOrderDetails(argument: _fietCexNode_OrderDetailsRequest, callback: grpc.requestCallback<_fietCexNode_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  getOrderDetails(argument: _fietCexNode_OrderDetailsRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  getOrderDetails(argument: _fietCexNode_OrderDetailsRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  getOrderDetails(argument: _fietCexNode_OrderDetailsRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  getOrderDetails(argument: _fietCexNode_OrderDetailsRequest, callback: grpc.requestCallback<_fietCexNode_OrderDetailsResponse__Output>): grpc.ClientUnaryCall;
  
  Transfer(argument: _fietCexNode_TransferRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_TransferResponse__Output>): grpc.ClientUnaryCall;
  Transfer(argument: _fietCexNode_TransferRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_TransferResponse__Output>): grpc.ClientUnaryCall;
  Transfer(argument: _fietCexNode_TransferRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_TransferResponse__Output>): grpc.ClientUnaryCall;
  Transfer(argument: _fietCexNode_TransferRequest, callback: grpc.requestCallback<_fietCexNode_TransferResponse__Output>): grpc.ClientUnaryCall;
  transfer(argument: _fietCexNode_TransferRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_TransferResponse__Output>): grpc.ClientUnaryCall;
  transfer(argument: _fietCexNode_TransferRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_fietCexNode_TransferResponse__Output>): grpc.ClientUnaryCall;
  transfer(argument: _fietCexNode_TransferRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_fietCexNode_TransferResponse__Output>): grpc.ClientUnaryCall;
  transfer(argument: _fietCexNode_TransferRequest, callback: grpc.requestCallback<_fietCexNode_TransferResponse__Output>): grpc.ClientUnaryCall;
  
}

export interface CexServiceHandlers extends grpc.UntypedServiceImplementation {
  CancelOrder: grpc.handleUnaryCall<_fietCexNode_CancelOrderRequest__Output, _fietCexNode_CancelOrderResponse>;
  
  Convert: grpc.handleUnaryCall<_fietCexNode_ConvertRequest__Output, _fietCexNode_ConvertResponse>;
  
  Deposit: grpc.handleUnaryCall<_fietCexNode_DepositConfirmationRequest__Output, _fietCexNode_DepositConfirmationResponse>;
  
  GetBalance: grpc.handleUnaryCall<_fietCexNode_BalanceRequest__Output, _fietCexNode_BalanceResponse>;
  
  GetOptimalPrice: grpc.handleUnaryCall<_fietCexNode_OptimalPriceRequest__Output, _fietCexNode_OptimalPriceResponse>;
  
  GetOrderDetails: grpc.handleUnaryCall<_fietCexNode_OrderDetailsRequest__Output, _fietCexNode_OrderDetailsResponse>;
  
  Transfer: grpc.handleUnaryCall<_fietCexNode_TransferRequest__Output, _fietCexNode_TransferResponse>;
  
}

export interface CexServiceDefinition extends grpc.ServiceDefinition {
  CancelOrder: MethodDefinition<_fietCexNode_CancelOrderRequest, _fietCexNode_CancelOrderResponse, _fietCexNode_CancelOrderRequest__Output, _fietCexNode_CancelOrderResponse__Output>
  Convert: MethodDefinition<_fietCexNode_ConvertRequest, _fietCexNode_ConvertResponse, _fietCexNode_ConvertRequest__Output, _fietCexNode_ConvertResponse__Output>
  Deposit: MethodDefinition<_fietCexNode_DepositConfirmationRequest, _fietCexNode_DepositConfirmationResponse, _fietCexNode_DepositConfirmationRequest__Output, _fietCexNode_DepositConfirmationResponse__Output>
  GetBalance: MethodDefinition<_fietCexNode_BalanceRequest, _fietCexNode_BalanceResponse, _fietCexNode_BalanceRequest__Output, _fietCexNode_BalanceResponse__Output>
  GetOptimalPrice: MethodDefinition<_fietCexNode_OptimalPriceRequest, _fietCexNode_OptimalPriceResponse, _fietCexNode_OptimalPriceRequest__Output, _fietCexNode_OptimalPriceResponse__Output>
  GetOrderDetails: MethodDefinition<_fietCexNode_OrderDetailsRequest, _fietCexNode_OrderDetailsResponse, _fietCexNode_OrderDetailsRequest__Output, _fietCexNode_OrderDetailsResponse__Output>
  Transfer: MethodDefinition<_fietCexNode_TransferRequest, _fietCexNode_TransferResponse, _fietCexNode_TransferRequest__Output, _fietCexNode_TransferResponse__Output>
}
