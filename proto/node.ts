import type * as grpc from '@grpc/grpc-js';
import type { EnumTypeDefinition, MessageTypeDefinition } from '@grpc/proto-loader';

import type { CexServiceClient as _cexBroker_CexServiceClient, CexServiceDefinition as _cexBroker_CexServiceDefinition } from './cexBroker/CexService';

type SubtypeConstructor<Constructor extends new (...args: any) => any, Subtype> = {
  new(...args: ConstructorParameters<Constructor>): Subtype;
};

export interface ProtoGrpcType {
  cexBroker: {
    Action: EnumTypeDefinition
    CcxtActionRequest: MessageTypeDefinition
    CcxtActionResponse: MessageTypeDefinition
    CexService: SubtypeConstructor<typeof grpc.Client, _cexBroker_CexServiceClient> & { service: _cexBroker_CexServiceDefinition }
  }
}

