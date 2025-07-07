import type * as grpc from '@grpc/grpc-js';
import type { EnumTypeDefinition, MessageTypeDefinition } from '@grpc/proto-loader';

import type { CexServiceClient as _fietCexNode_CexServiceClient, CexServiceDefinition as _fietCexNode_CexServiceDefinition } from './fietCexNode/CexService';

type SubtypeConstructor<Constructor extends new (...args: any) => any, Subtype> = {
  new(...args: ConstructorParameters<Constructor>): Subtype;
};

export interface ProtoGrpcType {
  fietCexNode: {
    BalanceRequest: MessageTypeDefinition
    BalanceResponse: MessageTypeDefinition
    CancelOrderRequest: MessageTypeDefinition
    CancelOrderResponse: MessageTypeDefinition
    CexService: SubtypeConstructor<typeof grpc.Client, _fietCexNode_CexServiceClient> & { service: _fietCexNode_CexServiceDefinition }
    ConvertRequest: MessageTypeDefinition
    ConvertResponse: MessageTypeDefinition
    DepositConfirmationRequest: MessageTypeDefinition
    DepositConfirmationResponse: MessageTypeDefinition
    OptimalPriceRequest: MessageTypeDefinition
    OptimalPriceResponse: MessageTypeDefinition
    OrderDetailsRequest: MessageTypeDefinition
    OrderDetailsResponse: MessageTypeDefinition
    OrderMode: EnumTypeDefinition
    PriceInfo: MessageTypeDefinition
    TransferRequest: MessageTypeDefinition
    TransferResponse: MessageTypeDefinition
  }
}

