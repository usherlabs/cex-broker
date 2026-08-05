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

RUN bun install --global @usherlabs/cex-broker@0.2.6

COPY --chmod=0755 ./.sandbox/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

CMD ["cex-broker"]
