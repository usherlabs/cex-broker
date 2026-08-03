import { z } from "zod";

export const OHLCV_COLLECTOR_CONFIG_ENV = "CEX_BROKER_OHLCV_COLLECTOR_CONFIG";
export const MARKET_DATA_COLLECTOR_CONFIG_ENV =
	"CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG";

const exchangeSchema = z
	.string()
	.trim()
	.min(1)
	.transform((value) => value.toLowerCase());
const symbolSchema = z.string().trim().min(1);

const marketSubscriptionSchema = z.discriminatedUnion("feed", [
	z
		.object({
			exchange: exchangeSchema,
			symbol: symbolSchema,
			feed: z.literal("ORDERBOOK"),
			depthLimit: z.number().int().min(1).max(500),
		})
		.strict(),
	z
		.object({
			exchange: exchangeSchema,
			symbol: symbolSchema,
			feed: z.literal("TICKER"),
		})
		.strict(),
	z
		.object({
			exchange: exchangeSchema,
			symbol: symbolSchema,
			feed: z.literal("TRADES"),
		})
		.strict(),
	z
		.object({
			exchange: exchangeSchema,
			symbol: symbolSchema,
			feed: z.literal("OHLCV"),
			timeframe: z.string().trim().min(1),
			bootstrapLimit: z.number().int().min(0).max(1_000).default(100),
		})
		.strict(),
]);

const marketConfigSchema = z
	.object({
		captureBundleId: z.string().trim().optional(),
		environment: z.enum(["development", "production"]).default("production"),
		subscriptions: z.array(marketSubscriptionSchema).min(1),
	})
	.strict()
	.superRefine((config, context) => {
		if (config.environment === "production" && !config.captureBundleId) {
			context.addIssue({
				code: "custom",
				message: "captureBundleId is required in production",
				path: ["captureBundleId"],
			});
		}
		const seen = new Set<string>();
		for (const [index, subscription] of config.subscriptions.entries()) {
			const options =
				subscription.feed === "ORDERBOOK"
					? String(subscription.depthLimit)
					: subscription.feed === "OHLCV"
						? `${subscription.timeframe}:${subscription.bootstrapLimit}`
						: "";
			const key = `${subscription.exchange}\u0000${subscription.symbol}\u0000${subscription.feed}\u0000${options}`;
			if (seen.has(key)) {
				context.addIssue({
					code: "custom",
					message: "duplicate feed subscription",
					path: ["subscriptions", index],
				});
			}
			seen.add(key);
		}
	});

export type MarketDataSubscription = z.infer<typeof marketSubscriptionSchema>;
export type MarketDataCollectorConfig = z.infer<typeof marketConfigSchema>;

function formatZodIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "config";
			return `${path}: ${issue.message}`;
		})
		.join("; ");
}

export function parseMarketDataCollectorConfig(
	input: unknown,
): MarketDataCollectorConfig {
	const result = marketConfigSchema.safeParse(input);
	if (!result.success) {
		throw new Error(
			`Invalid market-data collector config: ${formatZodIssues(result.error)}`,
		);
	}
	return result.data;
}

export async function loadMarketDataCollectorConfig(
	configPath = process.env[MARKET_DATA_COLLECTOR_CONFIG_ENV],
): Promise<MarketDataCollectorConfig> {
	const path = configPath?.trim();
	if (!path) {
		throw new Error(
			`${MARKET_DATA_COLLECTOR_CONFIG_ENV} must point to a JSON file`,
		);
	}
	let contents: string;
	try {
		contents = await Bun.file(path).text();
	} catch (error) {
		throw new Error(`Failed to read market-data collector config at ${path}`, {
			cause: error,
		});
	}
	try {
		return parseMarketDataCollectorConfig(JSON.parse(contents));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(
				`Market-data collector config at ${path} is not valid JSON`,
				{ cause: error },
			);
		}
		throw error;
	}
}

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
		throw new Error(
			`Invalid OHLCV collector config: ${formatZodIssues(result.error)}`,
		);
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
