# Market-data collector: keeps one external Subscribe stream alive for every
# configured feed intent against CEX_BROKER_URL.
#
# Build from the repository root:
#   docker build -f services/ohlcv-collector/Dockerfile -t cex-broker-market-data-collector .
#
# Set CEX_BROKER_URL to the external broker target and
# CEX_BROKER_MARKET_DATA_COLLECTOR_CONFIG to a JSON document containing
# {"subscriptions":[...]} feed intents.
FROM oven/bun:1.3

WORKDIR /app

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY src ./src
COPY services/ohlcv-collector ./services/ohlcv-collector

# The collector needs no elevated privileges; run as the base image's bun user.
USER bun

CMD ["bun", "run", "start-market-data-collector"]
