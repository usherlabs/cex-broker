#!/usr/bin/env bash

set -euo pipefail

repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
image_tag="${ARCHIVE_FORWARDER_SMOKE_IMAGE:-cex-broker-archive-forwarder:smoke}"
container_name="archive-forwarder-image-smoke-$$"

cleanup() {
  docker logs "$container_name" 2>/dev/null || true
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build \
  --file "$repository_dir/services/archive-forwarder/Dockerfile" \
  --tag "$image_tag" \
  "$repository_dir"

docker run --detach \
  --name "$container_name" \
  --env CLICKHOUSE_URL=http://127.0.0.1:9 \
  "$image_tag" >/dev/null

if docker exec "$container_name" test -e /app/services/archive-forwarder/scripts; then
  echo "archive-forwarder image unexpectedly contains operator scripts" >&2
  exit 1
fi

for _ in $(seq 1 30); do
  if body="$(docker exec "$container_name" bun -e '
    const response = await fetch("http://127.0.0.1:8090/health", {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) process.exit(1);
    console.log(await response.text());
  ' 2>/dev/null)"; then
    if grep --quiet '"durableAdmission":true' <<<"$body"; then
      exit 0
    fi
    echo "archive-forwarder health omitted durable admission: $body" >&2
    exit 1
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != "true" ]; then
    echo "archive-forwarder image exited before health became available" >&2
    exit 1
  fi
  sleep 1
done

echo "archive-forwarder image did not expose health within 30 seconds" >&2
exit 1
