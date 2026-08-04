import { isIP } from "node:net";
import { z } from "zod";

export const MARKET_DATA_COLLECTOR_CONFIG_ENV =
	"CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG";
export const COLLECTOR_BROKER_URL_ENV = "CEX_BROKER_URL";
export const OHLCV_COLLECTOR_CONFIG_ENV = "CEX_BROKER_OHLCV_COLLECTOR_CONFIG";

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
		subscriptions: z.array(marketSubscriptionSchema).min(1),
	})
	.strict()
	.superRefine((config, context) => {
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

function invalidBrokerUrl(reason: string): Error {
	return new Error(
		`${COLLECTOR_BROKER_URL_ENV} must be a host:port or [IPv6]:port gRPC authority (${reason})`,
	);
}

function isValidHostname(host: string): boolean {
	if (host.length > 253) return false;
	return host
		.split(".")
		.every(
			(label) =>
				label.length > 0 &&
				label.length <= 63 &&
				/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
		);
}

export function parseCollectorBrokerUrl(input: unknown): string {
	if (typeof input !== "string" || !input.trim()) {
		throw invalidBrokerUrl("value is required");
	}
	const authority = input.trim();
	let host: string;
	let portText: string;

	if (authority.startsWith("[")) {
		const match = /^\[([^\]]+)\]:(\d+)$/.exec(authority);
		if (!match || isIP(match[1]) !== 6) {
			throw invalidBrokerUrl("invalid bracketed IPv6 address");
		}
		[, host, portText] = match;
	} else {
		const match = /^([^:\s]+):(\d+)$/.exec(authority);
		if (!match) throw invalidBrokerUrl("invalid authority");
		[, host, portText] = match;
		if (isIP(host) !== 4 && !isValidHostname(host)) {
			throw invalidBrokerUrl("invalid hostname or IPv4 address");
		}
	}

	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw invalidBrokerUrl("port must be between 1 and 65535");
	}
	return authority;
}

export function loadCollectorBrokerUrl(
	value = process.env[COLLECTOR_BROKER_URL_ENV],
): string {
	return parseCollectorBrokerUrl(value);
}

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

const ohlcvSubscriptionSchema = z
	.object({
		exchange: exchangeSchema,
		symbol: symbolSchema,
		timeframe: z.string().trim().min(1).default("1m"),
	})
	.strict();

const ohlcvConfigSchema = z
	.array(ohlcvSubscriptionSchema)
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

export type OhlcvSubscription = z.infer<typeof ohlcvSubscriptionSchema>;

export function parseOhlcvCollectorConfig(input: unknown): OhlcvSubscription[] {
	const result = ohlcvConfigSchema.safeParse(input);
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

	try {
		return parseOhlcvCollectorConfig(JSON.parse(contents));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`OHLCV collector config at ${path} is not valid JSON`, {
				cause: error,
			});
		}
		throw error;
	}
}
