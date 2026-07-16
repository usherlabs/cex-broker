import { z } from "zod";

export const OHLCV_COLLECTOR_CONFIG_ENV = "CEX_BROKER_OHLCV_COLLECTOR_CONFIG";

const subscriptionSchema = z
	.object({
		exchange: z
			.string()
			.trim()
			.min(1)
			.transform((value) => value.toLowerCase()),
		symbol: z.string().trim().min(1),
		timeframe: z.string().trim().min(1).default("1m"),
	})
	.strict();

const configSchema = z
	.array(subscriptionSchema)
	.min(1, "at least one OHLCV subscription is required")
	.superRefine((subscriptions, context) => {
		const seen = new Set<string>();
		for (const [index, subscription] of subscriptions.entries()) {
			const key = `${subscription.exchange}\u0000${subscription.symbol}\u0000${subscription.timeframe}`;
			if (seen.has(key)) {
				context.addIssue({
					code: "custom",
					message: "duplicate OHLCV subscription",
					path: [index],
				});
			}
			seen.add(key);
		}
	});

export type OhlcvSubscription = z.infer<typeof subscriptionSchema>;

export function parseOhlcvCollectorConfig(input: unknown): OhlcvSubscription[] {
	const result = configSchema.safeParse(input);
	if (!result.success) {
		const details = result.error.issues
			.map((issue) => {
				const path = issue.path.length > 0 ? issue.path.join(".") : "config";
				return `${path}: ${issue.message}`;
			})
			.join("; ");
		throw new Error(`Invalid OHLCV collector config: ${details}`);
	}
	return result.data;
}

export async function loadOhlcvCollectorConfig(
	configPath = process.env[OHLCV_COLLECTOR_CONFIG_ENV],
): Promise<OhlcvSubscription[]> {
	const path = configPath?.trim();
	if (!path) {
		throw new Error(`${OHLCV_COLLECTOR_CONFIG_ENV} must point to a JSON file`);
	}

	let contents: string;
	try {
		contents = await Bun.file(path).text();
	} catch (error) {
		throw new Error(`Failed to read OHLCV collector config at ${path}`, {
			cause: error,
		});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw new Error(`OHLCV collector config at ${path} is not valid JSON`, {
			cause: error,
		});
	}

	return parseOhlcvCollectorConfig(parsed);
}
