import {
	extractTrades,
	parseTicker,
} from "../src/helpers/market-data-archive/parse-stream";
import {
	buildCandleRow,
	buildCexStreamEventRow,
	buildCexTickerEventRow,
	buildCexTradeRow,
	buildOrderbookSnapshotRow,
} from "../src/helpers/market-data-archive/rows";

type Input = {
	orderbook: Parameters<typeof buildOrderbookSnapshotRow>[0];
	candle: Parameters<typeof buildCandleRow>[0];
	stream: Parameters<typeof buildCexStreamEventRow>[0];
	ticker: {
		input: Parameters<typeof buildCexTickerEventRow>[0];
		parsed: Parameters<typeof buildCexTickerEventRow>[1];
	};
	trade: {
		input: Parameters<typeof buildCexTradeRow>[0];
		parsed: Parameters<typeof buildCexTradeRow>[1];
	};
	remainingRows: Array<{
		table: string;
		row: Record<string, unknown>;
	}>;
};

const inputPath = process.argv[2];
if (!inputPath) {
	throw new Error("archive baseline input path is required");
}

const input = (await Bun.file(inputPath).json()) as Input;
const orderbook = buildOrderbookSnapshotRow(input.orderbook);
if (!orderbook) {
	throw new Error("deterministic baseline order book did not produce a row");
}
const ticker = parseTicker(
	input.ticker.input.payload,
	input.ticker.input.receivedTimestamp,
);
const trade = extractTrades(
	input.trade.input.payload,
	input.trade.input.receivedTimestamp,
)[0];
if (!ticker || !trade) {
	throw new Error("deterministic baseline feed payload did not parse");
}

const rows = [
	buildCandleRow(input.candle),
	orderbook,
	buildCexStreamEventRow(input.stream),
	buildCexTickerEventRow(input.ticker.input, ticker),
	buildCexTradeRow(input.trade.input, trade),
	...input.remainingRows,
];

process.stdout.write(`${JSON.stringify(rows)}\n`);
