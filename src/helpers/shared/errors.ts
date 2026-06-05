import { log } from "../logger";

export function getErrorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === "string"
			? error
			: "Unknown error";
}

export function safeLogError(context: string, error: unknown): void {
	try {
		log.error(context, { error });
	} catch {
		console.error(context, error);
	}
}
