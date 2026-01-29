# OpenTelemetry + ClickHouse (no Prometheus)

Metrics flow: **CEX Broker** → OTLP HTTP → **Collector** → **ClickHouse**.  
There is no Prometheus exporter; metrics go only to ClickHouse.

## Option 1: Docker (recommended)

```bash
# From repo root
docker compose -f docker-compose.otel.yaml up -d

# Wait for ClickHouse to be healthy (~10s), then start the broker with:
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=cex-broker
bun run start-broker --policy policy/policy.json --port 8086 --whitelistAll
```

- **Collector OTLP HTTP**: `http://localhost:4318` (broker sends here)
- **Collector OTLP gRPC**: `localhost:4317`
- **ClickHouse HTTP**: `http://localhost:8123` (queries)

### Query metrics in ClickHouse

```bash
# Connect to ClickHouse (Docker)
docker exec -it cex-broker-clickhouse clickhouse-client

# Or use HTTP
curl 'http://localhost:8123/?query=SELECT%20*%20FROM%20otel.otel_metrics_sum%20LIMIT%2010'
```

Tables created by the collector (in database `otel`):

- `otel_metrics_sum` – counter-like metrics
- `otel_metrics_histogram` – histograms (e.g. duration_ms)
- `otel_metrics_gauge` – gauges

## Option 2: Local (no Docker)

### 1. Install and run ClickHouse

```bash
# macOS (Homebrew)
brew install clickhouse
clickhouse server

# Or use Docker only for ClickHouse
docker run -d -p 8123:8123 -p 9000:9000 --name clickhouse clickhouse/clickhouse-server:24
```

### 2. Install and run the collector

Download [otelcol-contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib/releases) for your OS, then:

```bash
# If ClickHouse is on localhost
# Edit otel/collector-config.yaml: set endpoint to tcp://127.0.0.1:9000 (or clickhouse://127.0.0.1:9000)

./otelcol-contrib --config=otel/collector-config.yaml
```

### 3. Start the broker

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
bun run start-broker --policy policy/policy.json --port 8086 --whitelistAll
```

## Config files

| File | Purpose |
|------|---------|
| `otel/collector-config.yaml` | Collector: OTLP receiver → batch → **ClickHouse exporter** (no Prometheus). |
| `docker-compose.otel.yaml` | Runs ClickHouse + otelcol-contrib with the above config. |

## Stopping Docker stack

```bash
docker compose -f docker-compose.otel.yaml down
# Optional: remove volume
docker compose -f docker-compose.otel.yaml down -v
```

## Port conflicts

If `8123` or `9000` are already in use (e.g. local ClickHouse), edit `docker-compose.otel.yaml` and change the **host** (left) port, e.g. `"18123:8123"` and `"19000:9000"`. The broker still uses `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (collector port 4318 is separate).
