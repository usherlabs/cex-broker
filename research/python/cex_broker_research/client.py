from __future__ import annotations

import clickhouse_connect

from cex_broker_research.config import ClickHouseSettings, load_clickhouse_settings


def get_client(settings: ClickHouseSettings | None = None):
    resolved = settings or load_clickhouse_settings()
    return clickhouse_connect.get_client(
        host=resolved.host,
        port=resolved.port,
        username=resolved.username,
        password=resolved.password,
        database=resolved.database,
    )
