// Package checks must not initialize operator archives, credentials or telemetry.
export function packageConsumerEnvironment(environment = process.env) {
	return Object.fromEntries(
		Object.entries(environment).filter(
			([key]) => !key.startsWith("CEX_BROKER_") && !key.startsWith("OTEL_"),
		),
	);
}
