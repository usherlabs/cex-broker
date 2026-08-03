# Archive forwarder: receives cex-broker archive batches over HTTP (POST /archive)
# and writes them to ClickHouse (market_data, broker_execution, strategy_data).
# It self-initializes the durable spool before listening and retries ClickHouse
# schema initialization without giving up durable Maker admission.
#
# Build from the repository ROOT so the schema/ directory is in the build context:
#   docker build -f services/archive-forwarder/Dockerfile -t cex-broker-archive-forwarder .
FROM oven/bun:1.3

WORKDIR /app

# Install dependencies from the frozen lockfile. patches/ is required because
# package.json pins patchedDependencies; the forwarder itself only imports
# @clickhouse/client plus Bun built-ins, but a frozen install needs the manifest.
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

# Forwarder source and the SQL files its schema initializer applies at startup
# (schema.ts resolves ../../schema/clickhouse relative to this directory).
COPY services/archive-forwarder ./services/archive-forwarder
COPY src/helpers/otel.ts src/helpers/logger.ts ./src/helpers/
COPY schema/clickhouse ./schema/clickhouse

ENV ARCHIVE_FORWARDER_PORT=8090
ENV ARCHIVE_FORWARDER_SPOOL_PATH=/var/lib/archive-forwarder/spool.sqlite
VOLUME ["/var/lib/archive-forwarder"]
EXPOSE 8090

CMD ["bun", "run", "services/archive-forwarder/index.ts"]
