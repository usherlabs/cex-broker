#!/usr/bin/env bun
import { z } from "zod";
import {
	type CanonicalMarketReplayWindow,
	validateCanonicalMarketReplayWindow,
} from "./export-canonical-orderbook-parquet";

const replayWindowSchema = z
	.object({
		captureBundleIds: z.array(z.string().trim().min(1)).min(1),
		exchange: z.string().trim().min(1),
		tradingPair: z.string().trim().min(1),
		startTimeMs: z.number().int().nonnegative(),
		endTimeMs: z.number().int().positive(),
	})
	.strict()
	.refine((window) => window.endTimeMs > window.startTimeMs, {
		message: "endTimeMs must be greater than startTimeMs",
		path: ["endTimeMs"],
	});

const replayConfigSchema = z
	.object({
		windows: z
			.array(replayWindowSchema)
			.min(1, "at least one validation window is required"),
	})
	.strict();

export type ReplayValidationWindow = z.infer<typeof replayWindowSchema>;

export function parseReplayValidationConfig(
	input: unknown,
): ReplayValidationWindow[] {
	const result = replayConfigSchema.safeParse(input);
	if (!result.success) {
		const detail = result.error.issues
			.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid replay validation config: ${detail}`);
	}
	return result.data.windows;
}

async function loadConfig(path: string): Promise<ReplayValidationWindow[]> {
	let input: unknown;
	try {
		input = JSON.parse(await Bun.file(path).text());
	} catch (error) {
		throw new Error(`Unable to read replay validation config at ${path}`, {
			cause: error,
		});
	}
	return parseReplayValidationConfig(input);
}

if (import.meta.main) {
	const configPath = process.env.CEX_BROKER_REPLAY_VALIDATION_CONFIG?.trim();
	if (!configPath) {
		throw new Error("CEX_BROKER_REPLAY_VALIDATION_CONFIG is required");
	}
	const clickhouseUrl =
		process.env.CLICKHOUSE_URL?.trim() ||
		`http://${process.env.CLICKHOUSE_HOST?.trim() || "localhost"}:${process.env.CLICKHOUSE_PORT?.trim() || "8123"}`;
	const shared = {
		clickhouseUrl,
		username: process.env.CLICKHOUSE_USER?.trim(),
		password: process.env.CLICKHOUSE_PASSWORD,
	};
	const validated = [];
	for (const window of await loadConfig(configPath)) {
		const input: CanonicalMarketReplayWindow = { ...shared, ...window };
		validated.push({
			window,
			result: await validateCanonicalMarketReplayWindow(input),
		});
	}
	console.info(
		JSON.stringify({ status: "valid", windows: validated }, null, 2),
	);
}
