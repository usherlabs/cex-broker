FROM oven/bun:1.3

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN bun install --global @usherlabs/cex-broker@0.2.2

COPY --chmod=0755 ./.sandbox/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

CMD ["cex-broker"]
