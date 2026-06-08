export function depositField(
	deposit: Record<string, unknown>,
	fields: string[],
) {
	for (const field of fields) {
		const value = deposit[field];
		if (value !== undefined && value !== null && String(value).length > 0) {
			return value;
		}
	}
	return undefined;
}

export function normalizeDepositStatus(
	status: unknown,
):
	| "unsupported"
	| "not_found"
	| "pending"
	| "credited"
	| "failed"
	| "timed_out" {
	const normalized = String(status ?? "")
		.trim()
		.toLowerCase();
	if (
		["ok", "credited", "complete", "completed", "success"].includes(normalized)
	) {
		return "credited";
	}
	if (
		["failed", "failure", "canceled", "cancelled", "rejected"].includes(
			normalized,
		)
	) {
		return "failed";
	}
	if (["timeout", "timed_out", "timedout", "expired"].includes(normalized)) {
		return "timed_out";
	}
	if (["pending", "processing", "confirming", "waiting"].includes(normalized)) {
		return "pending";
	}
	return "pending";
}

export function depositMatchesTransaction(
	deposit: Record<string, unknown>,
	transactionHash: string,
): boolean {
	const candidates = [
		depositField(deposit, [
			"txid",
			"txId",
			"tx_hash",
			"txHash",
			"transactionHash",
		]),
		depositField(deposit, ["id"]),
	];
	return candidates.some((candidate) => String(candidate) === transactionHash);
}

export function stringAmountEquals(left: unknown, right: unknown): boolean {
	const leftNum = Number(left);
	const rightNum = Number(right);
	if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
		return Math.abs(leftNum - rightNum) < 1e-12;
	}
	return String(left) === String(right);
}

export function normalizeAddress(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	return String(value).trim().toLowerCase();
}
