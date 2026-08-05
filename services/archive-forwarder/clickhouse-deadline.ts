// @clickhouse/client documents a `request_timeout` (30s by default), but that
// timeout is not enforced under Bun: a request whose response never arrives
// stays open indefinitely instead of failing. Verified against a frozen
// ClickHouse — an unanswered request was still pending after 100s, while the
// same request carrying an abort signal failed at its deadline, and the
// connection pool served later requests normally once the server recovered.
//
// The forwarder therefore attaches an explicit deadline to every ClickHouse
// request. This enforces the client's own documented timeout rather than
// introducing a new one, so a healthy server behaves exactly as before; what
// changes is that a lost response becomes a failure the caller can see and
// count instead of a permanently stalled request.
export const CLICKHOUSE_REQUEST_TIMEOUT_MS = 30_000;

export function clickHouseRequestDeadline(): AbortSignal {
	return AbortSignal.timeout(CLICKHOUSE_REQUEST_TIMEOUT_MS);
}
