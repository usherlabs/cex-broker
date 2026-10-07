import ccxt from "ccxt";

/** MEXC uses an unmapped venue code for a missing spot order. */
export function isOrderNotFound(exchange: string, error: unknown): boolean {
	if (error instanceof ccxt.OrderNotFound) return true;
	if (exchange !== "mexc" || !(error instanceof ccxt.ExchangeError))
		return false;
	if (!error.message.startsWith("mexc ")) return false;
	try {
		const reply: unknown = JSON.parse(error.message.slice("mexc ".length));
		return (
			typeof reply === "object" &&
			reply !== null &&
			"code" in reply &&
			reply.code === -2013 &&
			"msg" in reply &&
			reply.msg === "Order does not exist."
		);
	} catch {
		return false;
	}
}
