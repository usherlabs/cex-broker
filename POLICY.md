# Policy Configuration

The CEX Broker uses a JSON policy file to enforce constraints on withdrawals, deposits, and orders. The broker validates every action against the active policy before execution.

Pass the policy file when starting the broker:

```bash
bun run start-broker --policy policy/policy.json
```

Policies are hot-reloaded — changes take effect without restarting the server.

## Schema Overview

```jsonc
{
  "withdraw": { "rule": { /* WithdrawRule */ } },
  "deposit":  { "rule": [ /* DepositRuleEntry[] */ ] },
  "order":    { "rule": { /* OrderRule */ } }
}
```

All three top-level keys (`withdraw`, `deposit`, `order`) are required. See sections below for each rule type.

---

## Withdraw Rules

Withdraw validation gates the `Withdraw` action. Every withdrawal must pass all checks: network, whitelist, coin, and amount.

### Structure

```jsonc
{
  "withdraw": {
    "rule": {
      "networks": ["ARBITRUM", "BEP20"],          // required — allowed network identifiers
      "whitelist": ["0xabc..."],                   // required — allowed recipient addresses (lowercased for matching)
      "coins": ["ETH", "USDT", "USDC"],           // optional — allowed CEX ticker symbols
      "amounts": [                                 // required — per-ticker min/max limits
        { "ticker": "USDT", "min": 1, "max": 100000 },
        { "ticker": "USDC", "min": 1, "max": 50000 }
      ]
    }
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `networks` | `string[]` | Yes | Allowed network identifiers (e.g. `"ARBITRUM"`, `"BEP20"`, `"ETH"`). |
| `whitelist` | `string[]` | Yes | Allowed recipient addresses. Matching is case-insensitive. |
| `coins` | `string[]` | No | Allowed CEX ticker symbols (e.g. `"ETH"`, `"USDT"`). |
| `amounts` | `object[]` | Yes | Per-ticker withdrawal limits. Each entry has `ticker`, `min`, and `max`. |

### Coin Filtering

The `coins` field restricts which tokens can be withdrawn, independent of the `amounts` check:

- **Omitted or empty array** — all tokens are allowed (backward compatible).
- **`["*"]`** — all tokens are allowed (explicit wildcard).
- **`["ETH", "USDT"]`** — only the listed tokens are allowed.

Matching is **case-insensitive**: `"eth"`, `"ETH"`, and `"Eth"` are all equivalent. Values are normalized to uppercase on load.

### Validation Order

1. Is the network in `networks`?
2. Is the recipient address in `whitelist`?
3. Is the ticker allowed by `coins`? (skipped when coins is absent/empty/wildcard)
4. Does a matching `amounts` entry exist for the ticker?
5. Is the amount within `[min, max]`?

### Example

```json
{
  "withdraw": {
    "rule": {
      "networks": ["ARBITRUM", "BEP20"],
      "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
      "coins": ["ETH", "USDT", "USDC", "ARB"],
      "amounts": [
        { "ticker": "USDC", "min": 1, "max": 100000 },
        { "ticker": "USDT", "min": 1, "max": 100000 }
      ]
    }
  }
}
```

---

## Deposit Rules

Deposit validation gates the `FetchDepositAddresses` action. If a deposit address request is rejected by policy, the caller cannot obtain a deposit address for that exchange/network/coin combination.

The deposit confirmation action (`Deposit`) is **not** gated by deposit policy — only address fetching is.

### Structure

```jsonc
{
  "deposit": {
    "rule": [
      { "exchange": "BINANCE", "network": "ARBITRUM", "coins": ["ETH", "USDT"] },
      { "exchange": "BINANCE", "network": "*",        "coins": ["USDC"] },
      { "exchange": "*",       "network": "*" }
    ]
  }
}
```

### Fields

Each entry in the `rule` array is a `DepositRuleEntry`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exchange` | `string` | Yes | CEX identifier (e.g. `"BINANCE"`, `"BYBIT"`) or `"*"` for any. |
| `network` | `string` | Yes | Network identifier (e.g. `"ARBITRUM"`, `"BEP20"`) or `"*"` for any. |
| `coins` | `string[]` | No | Allowed CEX ticker symbols. |

### Backward Compatibility

- **`"deposit": {}`** — no `rule` key: all deposits are allowed.
- **`"deposit": { "rule": [] }`** — empty array: all deposits are allowed.

This preserves backward compatibility with policies written before deposit rules existed.

### Rule Matching & Priority

When multiple rules could match a request, the most specific rule wins. Priority (highest to lowest):

| Priority | Exchange | Network | Example |
|----------|----------|---------|---------|
| 4 (highest) | exact | exact | `{ "exchange": "BINANCE", "network": "ARBITRUM" }` |
| 3 | exact | `*` | `{ "exchange": "BINANCE", "network": "*" }` |
| 2 | `*` | exact | `{ "exchange": "*", "network": "ARBITRUM" }` |
| 1 (lowest) | `*` | `*` | `{ "exchange": "*", "network": "*" }` |

If no rule matches (priority 0), the deposit is rejected.

### Coin Filtering

Within the matched rule, the `coins` field works the same as for withdrawals:

- **Omitted or empty array** — all tokens are allowed.
- **`["*"]`** — all tokens are allowed (explicit wildcard).
- **`["ETH", "USDT"]`** — only the listed tokens are allowed.

Matching is **case-insensitive**. Values are normalized to uppercase on load.

### Example

```json
{
  "deposit": {
    "rule": [
      { "exchange": "BINANCE", "network": "ARBITRUM", "coins": ["ETH", "USDT", "USDC", "ARB"] },
      { "exchange": "BINANCE", "network": "BEP20",   "coins": ["USDT", "USDC"] },
      { "exchange": "KRAKEN",  "network": "*",        "coins": ["ETH", "USDT", "USDC"] },
      { "exchange": "*",       "network": "*" }
    ]
  }
}
```

In this example:
- Deposits to Binance on Arbitrum allow ETH, USDT, USDC, ARB.
- Deposits to Binance on BEP20 allow only USDT and USDC.
- Deposits to Kraken on any network allow ETH, USDT, USDC.
- All other exchange/network combinations allow any token (catch-all).

---

## Order Rules

Order validation gates `CreateOrder`. Both the market and the conversion limits are checked.

### Structure

```jsonc
{
  "order": {
    "rule": {
      "markets": [
        "BINANCE:ARB/USDT",
        "BINANCE:ETH/USDT",
        "BYBIT:ARB/USDC"
      ],
      "limits": [
        { "from": "USDT", "to": "ETH", "min": 1, "max": 100000 },
        { "from": "ETH", "to": "USDT", "min": 0.5, "max": 5 }
      ]
    }
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `markets` | `string[]` | Yes | Allowed `EXCHANGE:BASE/QUOTE` market identifiers. |
| `limits` | `object[]` | Yes | Per-direction conversion limits with `from`, `to`, `min`, `max`. |

---

## Full Example

```json
{
  "withdraw": {
    "rule": {
      "networks": ["ARBITRUM", "BEP20"],
      "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
      "coins": ["ETH", "USDT", "USDC", "ARB"],
      "amounts": [
        { "ticker": "USDC", "min": 1, "max": 100000 },
        { "ticker": "USDT", "min": 1, "max": 100000 }
      ]
    }
  },
  "deposit": {
    "rule": [
      { "exchange": "BINANCE", "network": "ARBITRUM", "coins": ["ETH", "USDT", "USDC", "ARB"] },
      { "exchange": "*",       "network": "*" }
    ]
  },
  "order": {
    "rule": {
      "markets": [
        "BINANCE:ARB/USDT",
        "BINANCE:ETH/USDT",
        "BYBIT:ARB/USDC"
      ],
      "limits": [
        { "from": "USDT", "to": "ETH", "min": 1, "max": 100000 },
        { "from": "ETH", "to": "USDT", "min": 0.5, "max": 5 },
        { "from": "ARB", "to": "USDC", "min": 1, "max": 1000 },
        { "from": "USDC", "to": "ARB", "min": 1, "max": 10000 }
      ]
    }
  }
}
```

## Normalization

On load, the policy is normalized for consistent matching:

- Withdraw `coins` values are uppercased.
- Deposit rule `exchange`, `network`, and `coins` values are uppercased.

You can write values in any case in the JSON file.
