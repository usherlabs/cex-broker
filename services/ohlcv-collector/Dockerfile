# Market-data collector: connects to a separately deployed full CEX Broker and
# keeps configured Subscribe streams alive. It has no CEX credentials, embedded
# broker, archive writer, or ClickHouse connection.
#
# Build from the repository root:
#   docker build -f services/ohlcv-collector/Dockerfile -t cex-broker-ohlcv-collector .
#
# Set CEX_BROKER_URL=host:port and mount the canonical feed configuration named
# by CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG. The legacy OHLCV array variable is
# retained for compatibility.
FROM oven/bun:1.3

WORKDIR /app

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY src ./src
COPY services/ohlcv-collector ./services/ohlcv-collector

# The collector needs no elevated privileges; run as the base image's bun user.
USER bun

CMD ["bun", "run", "services/ohlcv-collector/index.ts"]
