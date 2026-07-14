-- Durable account-level CEX balance observations. Each row is one coherent
-- fetchBalance({ type: 'spot' }) response for one configured broker account.
-- Quantities are decimal strings produced from CCXT-normalized JavaScript numbers;
-- they are not venue-raw or atomic-unit precision.
-- NO TTL: these rows are replay evidence for later as-of diagnostics.

CREATE DATABASE IF NOT EXISTS broker_account;

CREATE TABLE IF NOT EXISTS broker_account.balance_snapshots
(
    broker_observed_timestamp DateTime64(3, 'UTC'),
    exchange_timestamp Nullable(DateTime64(3, 'UTC')),
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    exchange LowCardinality(String),
    account_selector LowCardinality(String),
    balance_scope LowCardinality(String),
    observation_id String,
    -- Union of aggregate-map keys and CCXT per-asset entries, including assets
    -- whose quantity is missing or non-numeric.
    reported_assets Array(String),
    asset_entry_assets Array(String),
    -- Only explicit finite CCXT-normalized quantities are stored. A missing key
    -- is unknown, while a present "0" is an explicit zero.
    free_balances Map(String, String),
    used_balances Map(String, String),
    total_balances Map(String, String),
    -- Whether CCXT supplied each aggregate map. Quantities can still be present
    -- from the coherent response's per-asset entries.
    aggregate_free_map_present UInt8,
    aggregate_used_map_present UInt8,
    aggregate_total_map_present UInt8,
    precision_basis LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(broker_observed_timestamp)
ORDER BY (exchange, account_selector, balance_scope, broker_observed_timestamp, observation_id);
