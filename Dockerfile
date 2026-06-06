FROM oven/bun:1.3

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
