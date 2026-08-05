# Pinned to an exact patch, not the floating 1.3 tag: bun <= 1.3.9 can drop the
# terminating chunk of an empty chunked HTTP response, which hangs a ClickHouse
# read forever. request_timeout cannot rescue it — the client implements that
# with socket.setTimeout, which Bun's node:http client ignores. Measured at ~1%
# of query bursts on 1.3.9 and zero on 1.3.12 and later, so keep this at 1.3.12
# or above.
FROM oven/bun:1.3.14

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY build.ts proto-gen.sh tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN bun run build

CMD ["bun", "./dist/commands/cli.js"]
