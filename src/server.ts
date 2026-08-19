import * as grpc from "@grpc/grpc-js";
import { createExecuteActionHandler } from "./handlers/execute-action";
import type { SubscribeBrokerLifecycle } from "./handlers/subscribe";
import { createSubscribeHandler } from "./handlers/subscribe";
import type { BrokerPoolEntry } from "./helpers";
import type {
	BrokerExecutionArchiver,
	WithdrawalObservationTracker,
} from "./helpers/broker-execution-archive";
import type { OrderActivityTracker } from "./helpers/order-activity-tracker";
import type { OtelMetrics } from "./helpers/otel";
import type { PublicMarketDataFeedSupervisor } from "./helpers/public-market-data-feed";
import type { UserDataStreamSupervisor } from "./helpers/user-data-stream-supervisor";
import { CEX_BROKER_PACKAGE_DEFINITION } from "./proto-package-definition";
import type { PolicyConfig } from "./types";

const grpcObj = grpc.loadPackageDefinition(
	CEX_BROKER_PACKAGE_DEFINITION,
) as unknown as {
	cex_broker: {
		cex_service: {
			service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>;
		};
	};
};
const cexNode = grpcObj.cex_broker;

export function getServer(
	policy: PolicyConfig,
	brokers: Record<string, BrokerPoolEntry>,
	whitelistIps: string[],
	useVerity: boolean,
	verityProverUrl: string,
	otelMetrics?: OtelMetrics,
	brokerArchiver?: BrokerExecutionArchiver,
	orderActivityTracker?: OrderActivityTracker,
	withdrawalObservationTracker?: WithdrawalObservationTracker,
	subscribeBrokerLifecycle?: SubscribeBrokerLifecycle,
	userDataStreamSupervisor?: UserDataStreamSupervisor,
	publicMarketDataFeedSupervisor?: PublicMarketDataFeedSupervisor,
) {
	const server = new grpc.Server();

	server.addService(cexNode.cex_service.service, {
		ExecuteAction: createExecuteActionHandler({
			policy,
			brokers,
			whitelistIps,
			useVerity,
			verityProverUrl,
			otelMetrics,
			brokerArchiver,
			orderActivityTracker,
			withdrawalObservationTracker,
		}),
		Subscribe: createSubscribeHandler({
			brokers,
			whitelistIps,
			otelMetrics,
			brokerArchiver,
			brokerLifecycle: subscribeBrokerLifecycle,
			userDataStreamSupervisor,
			publicMarketDataFeedSupervisor,
		}),
	});
	return server;
}
