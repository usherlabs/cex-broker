// Original file: proto/node.proto

import type * as grpc from '@grpc/grpc-js'
import type { MethodDefinition } from '@grpc/proto-loader'
import type { CcxtActionRequest as _cexBroker_CcxtActionRequest, CcxtActionRequest__Output as _cexBroker_CcxtActionRequest__Output } from '../cexBroker/CcxtActionRequest';
import type { CcxtActionResponse as _cexBroker_CcxtActionResponse, CcxtActionResponse__Output as _cexBroker_CcxtActionResponse__Output } from '../cexBroker/CcxtActionResponse';

export interface CexServiceClient extends grpc.Client {
  ExecuteCcxtAction(argument: _cexBroker_CcxtActionRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_CcxtActionResponse__Output>): grpc.ClientUnaryCall;
  ExecuteCcxtAction(argument: _cexBroker_CcxtActionRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_CcxtActionResponse__Output>): grpc.ClientUnaryCall;
  ExecuteCcxtAction(argument: _cexBroker_CcxtActionRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_CcxtActionResponse__Output>): grpc.ClientUnaryCall;
  ExecuteCcxtAction(argument: _cexBroker_CcxtActionRequest, callback: grpc.requestCallback<_cexBroker_CcxtActionResponse__Output>): grpc.ClientUnaryCall;
  executeCcxtAction(argument: _cexBroker_CcxtActionRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_CcxtActionResponse__Output>): grpc.ClientUnaryCall;
  executeCcxtAction(argument: _cexBroker_CcxtActionRequest, metadata: grpc.Metadata, callback: grpc.requestCallback<_cexBroker_CcxtActionResponse__Output>): grpc.ClientUnaryCall;
  executeCcxtAction(argument: _cexBroker_CcxtActionRequest, options: grpc.CallOptions, callback: grpc.requestCallback<_cexBroker_CcxtActionResponse__Output>): grpc.ClientUnaryCall;
  executeCcxtAction(argument: _cexBroker_CcxtActionRequest, callback: grpc.requestCallback<_cexBroker_CcxtActionResponse__Output>): grpc.ClientUnaryCall;
  
}

export interface CexServiceHandlers extends grpc.UntypedServiceImplementation {
  ExecuteCcxtAction: grpc.handleUnaryCall<_cexBroker_CcxtActionRequest__Output, _cexBroker_CcxtActionResponse>;
  
}

export interface CexServiceDefinition extends grpc.ServiceDefinition {
  ExecuteCcxtAction: MethodDefinition<_cexBroker_CcxtActionRequest, _cexBroker_CcxtActionResponse, _cexBroker_CcxtActionRequest__Output, _cexBroker_CcxtActionResponse__Output>
}
