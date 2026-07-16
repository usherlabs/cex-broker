# OHLCV collector: runs a loopback-only, keyless public broker and keeps one
# Subscribe(OHLCV) stream alive for every configured pair. The broker forwards
# captured candles to the separately deployed archive-forwarder.
#
# Build from the repository root:
#   docker build -f services/ohlcv-collector/Dockerfile -t cex-broker-ohlcv-collector .
#
# Mount a JSON array of {"exchange","symbol","timeframe"} entries and set
# CEX_BROKER_OHLCV_COLLECTOR_CONFIG to its container path. timeframe defaults to 1m.
FROM oven/bun:1.3

WORKDIR /app

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY src ./src
COPY services/ohlcv-collector ./services/ohlcv-collector

# Every reconnect invokes the broker's OHLCV bootstrap. At 1m, 1000 bars provide
# roughly 16 hours of gap coverage without adding a collector-side write/backfill path.
ENV CEX_BROKER_OHLCV_ARCHIVE_BOOTSTRAP_LIMIT=1000

# The collector needs no elevated privileges; run as the base image's bun user.
USER bun

CMD ["bun", "run", "services/ohlcv-collector/index.ts"]
