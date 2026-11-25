import * as grpc from "@grpc/grpc-js";
import {
	ACTION_VALIDATION_SCHEMA_VERSION,
	type ActionValidationInput,
	type ActionValidationOutcome,
	validateCreateOrderAction,
	validateDepositAddressAction,
	validateWithdrawAction,
} from "../../helpers/action-validation";
import {
	Action,
	type Action as ActionType,
	getActionName,
	resolveAction,
} from "../../helpers/constants";
import { mapCcxtErrorToGrpcStatus } from "../../helpers/grpc/status";
import { safeLogRedactedError } from "../../helpers/shared/errors";
import { sanitizeVenueError } from "../../helpers/venue-evidence";
import { ActionValidationEnvelopeSchema } from "../../schemas/action-evidence";
import { ValidateActionPayloadSchema } from "../../schemas/action-payloads";
import type { ExecuteActionContext } from "./context";
import { parsePayloadForAction } from "./context";

/**
 * ValidateAction: checks one CreateOrder, Withdraw or FetchDepositAddresses
 * request against broker policy, market or network rules and exchange
 * capabilities on the selected broker, and answers with a
 * cex-broker-action-validation/v1 envelope. It never places, withdraws or
 * requests an address.
 */
const VALIDATORS: Partial<
	Record<
		ActionType,
		(input: ActionValidationInput) => Promise<ActionValidationOutcome>
	>
> = {
	[Action.CreateOrder]: validateCreateOrderAction,
	[Action.Withdraw]: validateWithdrawAction,
	[Action.FetchDepositAddresses]: validateDepositAddressAction,
};

function invalidArgument(ctx: ExecuteActionContext, message: string): void {
	ctx.wrappedCallback({ code: grpc.status.INVALID_ARGUMENT, message }, null);
}

export async function handleValidateAction(
	ctx: ExecuteActionContext,
): Promise<void> {
	if (ctx.symbol?.trim()) {
		return invalidArgument(
			ctx,
			"ValidationError: ValidateAction symbol must be empty; set request.symbol",
		);
	}
	const payload = parsePayloadForAction(ctx, ValidateActionPayloadSchema);
	if (payload === null) {
		return;
	}
	const inner = payload.request;
	const innerAction = resolveAction(inner.action);
	const validator =
		innerAction === undefined ? undefined : VALIDATORS[innerAction];
	if (innerAction === undefined || validator === undefined) {
		return invalidArgument(
			ctx,
			`ValidationError: ${getActionName(inner.action)} cannot be validated; supported actions: CreateOrder, Withdraw, FetchDepositAddresses`,
		);
	}

	let outcome: ActionValidationOutcome;
	try {
		outcome = await validator({
			policy: ctx.policy,
			broker: ctx.broker,
			cex: ctx.cex,
			symbol: inner.symbol,
			payload: inner.payload,
		});
	} catch (error) {
		safeLogRedactedError(
			`ValidateAction ${getActionName(innerAction)} could not reach ${ctx.normalizedCex}`,
			error,
		);
		return ctx.wrappedCallback(
			{
				code: mapCcxtErrorToGrpcStatus(error) ?? grpc.status.UNAVAILABLE,
				message: `validation_unavailable: ${sanitizeVenueError(error, ctx.broker)}`,
			},
			null,
		);
	}

	const envelope = ActionValidationEnvelopeSchema.parse({
		schemaVersion: ACTION_VALIDATION_SCHEMA_VERSION,
		exchange: ctx.normalizedCex,
		action: getActionName(innerAction),
		symbol: inner.symbol,
		observedAt: new Date().toISOString(),
		...(outcome.valid
			? { valid: true, normalized: outcome.normalized, reasons: [] }
			: { valid: false, reasons: outcome.reasons }),
	});
	ctx.wrappedCallback(null, { result: JSON.stringify(envelope) });
}
