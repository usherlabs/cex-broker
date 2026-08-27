#!/usr/bin/env bash

set -euo pipefail

repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_tag="${ARCHIVE_FORWARDER_SMOKE_IMAGE:-cex-broker-archive-forwarder:smoke}"
container_name="archive-forwarder-image-smoke-$$"
host_port="${ARCHIVE_FORWARDER_SMOKE_PORT:-18090}"

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
  --publish "127.0.0.1:${host_port}:8090" \
  --env CLICKHOUSE_URL=http://127.0.0.1:9 \
  "$image_tag" >/dev/null

for _ in $(seq 1 30); do
  if body="$(curl --fail --silent --max-time 2 "http://127.0.0.1:${host_port}/health")"; then
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
