import { Logger } from "tslog";

const log = new Logger({
	type: process.env.NODE_ENV === "production" ? "json" : "pretty",
	stylePrettyLogs: process.env.NODE_ENV !== "production",
	minLevel: process.env.LOG_LEVEL === "debug" ? 0 : 3,
});

export { log };
