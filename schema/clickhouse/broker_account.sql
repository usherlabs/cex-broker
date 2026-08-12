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

-- Durable Binance user-asset observations. Each row is one coherent
-- `POST /sapi/v3/asset/getUserAsset` response for one configured broker account.
--
-- Why this exists alongside balance_snapshots: funds held under a travel-rule
-- freeze are OWNED but do not appear in free/locked, so api/v3/account (and the
-- fetchBalance snapshot above) reports them nowhere. getUserAsset is the only
-- endpoint that exposes the freeze bucket, so NAV must read it here or it
-- silently under-counts owned capital for as long as the freeze lasts.
--
-- Quantities are the venue's own decimal strings, stored verbatim (no CCXT
-- number round-trip) — a strictly better precision basis than balance_snapshots.
-- NO TTL: these rows are replay evidence for later as-of diagnostics.
CREATE TABLE IF NOT EXISTS broker_account.user_asset_snapshots
(
    -- The venue returns no timestamp on this endpoint, so there is no
    -- exchange_timestamp column: the broker read time is the only honest one.
    broker_observed_timestamp DateTime64(3, 'UTC'),
    source LowCardinality(String),
    deployment_id LowCardinality(String),
    schema_version LowCardinality(String),
    exchange LowCardinality(String),
    account_selector LowCardinality(String),
    balance_scope LowCardinality(String),
    observation_id String,
    -- Every asset the venue returned an entry for, whether or not each bucket
    -- parsed. Binance omits assets whose every bucket is zero.
    reported_assets Array(String),
    -- Assets for which at least one bucket was absent or non-numeric. A NAV
    -- reader must treat these as unknown (fail closed), not as zero.
    incomplete_assets Array(String),
    -- Only explicit numeric venue strings are stored. A missing key is unknown,
    -- while a present "0" is an explicit zero.
    free_balances Map(String, String),
    locked_balances Map(String, String),
    -- Travel-rule (and other compliance) holds, and in-flight withdrawals.
    -- Neither is counted inside free or locked — that is exactly why owned funds
    -- go invisible to fetchBalance — so NAV must add them, not assume overlap.
    freeze_balances Map(String, String),
    withdrawing_balances Map(String, String),
    precision_basis LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(broker_observed_timestamp)
ORDER BY (exchange, account_selector, balance_scope, broker_observed_timestamp, observation_id);
