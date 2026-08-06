# Market-data collector: connects to a separately deployed full CEX Broker and
# keeps one external Subscribe stream alive for every configured feed intent.
# It has no CEX credentials, embedded broker, archive writer, or ClickHouse
# connection.
#
# Build from the repository root:
#   docker build -f services/ohlcv-collector/Dockerfile -t cex-broker-market-data-collector .
#
# Set CEX_BROKER_URL=host:port and mount the canonical feed configuration named
# by CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG. The legacy OHLCV array variable is
# retained for compatibility.
# Pinned to an exact patch, not the floating 1.3 tag: bun <= 1.3.9 can drop the
# terminating chunk of an empty chunked HTTP response, which hangs a ClickHouse
# read forever. request_timeout cannot rescue it — the client implements that
# with socket.setTimeout, which Bun's node:http client ignores. Measured at ~1%
# of query bursts on 1.3.9 and zero on 1.3.12 and later, so keep this at 1.3.12
# or above.
FROM oven/bun:1.3.14

WORKDIR /app

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY src ./src
COPY services/ohlcv-collector ./services/ohlcv-collector

# The collector needs no elevated privileges; run as the base image's bun user.
USER bun

CMD ["bun", "run", "start-market-data-collector"]
