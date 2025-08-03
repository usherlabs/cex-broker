import type * as grpc from '@grpc/grpc-js';
import type { EnumTypeDefinition, MessageTypeDefinition } from '@grpc/proto-loader';

import type { cex_serviceClient as _cex_broker_cex_serviceClient, cex_serviceDefinition as _cex_broker_cex_serviceDefinition } from './cex_broker/cex_service';

type SubtypeConstructor<Constructor extends new (...args: any) => any, Subtype> = {
  new(...args: ConstructorParameters<Constructor>): Subtype;
};

export interface ProtoGrpcType {
  cex_broker: {
    Action: EnumTypeDefinition
    ActionRequest: MessageTypeDefinition
    ActionResponse: MessageTypeDefinition
    SubscribeRequest: MessageTypeDefinition
    SubscribeResponse: MessageTypeDefinition
    SubscriptionType: EnumTypeDefinition
    cex_service: SubtypeConstructor<typeof grpc.Client, _cex_broker_cex_serviceClient> & { service: _cex_broker_cex_serviceDefinition }
  }
}

