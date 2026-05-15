FROM oven/bun:1.3

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

EXPOSE 8086

CMD ["bun", "run", "start-broker", "--policy", "policy/policy.json", "--port", "8086", "--whitelistAll"]
