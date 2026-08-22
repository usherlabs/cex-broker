import { openTelemetryPlugin } from "@loglayer/plugin-opentelemetry";
import { OpenTelemetryTransport } from "@loglayer/transport-opentelemetry";
import { TsLogTransport } from "@loglayer/transport-tslog";
import { LogLayer } from "loglayer";
import { serializeError } from "serialize-error";
import { Logger } from "tslog";

const tslogLogger = new Logger({
	type: process.env.NODE_ENV === "production" ? "json" : "pretty",
	stylePrettyLogs: process.env.NODE_ENV !== "production",
	minLevel: process.env.LOG_LEVEL === "debug" ? 0 : 3,
});

const baseLogger = new LogLayer({
	transport: [new TsLogTransport({ id: "tslog", logger: tslogLogger })],
	plugins: [openTelemetryPlugin()],
	errorSerializer: serializeError,
});

const OTEL_TRANSPORT_ID = "otel";

export function attachOtelLogTransport(): void {
	baseLogger.addTransport(
		new OpenTelemetryTransport({
			id: OTEL_TRANSPORT_ID,
			enabled: process.env.NODE_ENV !== "test",
		}),
	);
}

export function detachOtelLogTransport(): void {
	baseLogger.removeTransport(OTEL_TRANSPORT_ID);
}

if (process.env.LOG_LEVEL !== "debug") {
	baseLogger.setLevel("info");
}

// Preserve broad call-site compatibility during migration from tslog to LogLayer.
const log = baseLogger as unknown as {
	trace: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	fatal: (...args: unknown[]) => void;
	withMetadata: LogLayer["withMetadata"];
};

export { log };
