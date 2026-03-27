## Policy configuration (`policy.json`)

This broker uses a JSON policy file to restrict:

- **Withdrawals**: permitted exchanges, networks, tokens, and destination address whitelist
- **Deposits**: permitted exchanges, networks, and tokens (gates deposit address fetching)
- **Orders**: permitted exchanges/pairs, plus optional directional conversion limits

The policy is loaded at startup. If you start the broker with a **policy file path**, the file is watched and policies are reloaded when the file changes.

## Quick start

- **Example policy**: `policy/policy.example.json`
- **Backtest policy**: `policy/policy.backtest.json`
- **CLI usage**:

```bash
bun run start-broker --policy policy/policy.json --port 8086 --whitelist 127.0.0.1
```

## File shape

Top-level keys (all required):

| Key | Type | Description |
|-----|------|-------------|
| `withdraw` | `{ rule: WithdrawRuleEntry[] }` | Withdrawal restrictions (at least one rule entry required) |
| `deposit` | `{ rule?: DepositRuleEntry[] }` | Deposit restrictions (optional; omitting `rule` or using `{}` allows all) |
| `order` | `{ rule: OrderRule }` | Order/conversion restrictions |

Canonical type: `PolicyConfig` in `src/types.ts`.

```json
{
  "withdraw": {
    "rule": [
      { "exchange": "BINANCE", "network": "ARBITRUM", "coins": ["ETH", "USDT"], "whitelist": ["0x..."] }
    ]
  },
  "deposit": {
    "rule": [
      { "exchange": "BINANCE", "network": "ARBITRUM", "coins": ["ETH", "USDT"] }
    ]
  },
  "order": { "rule": { "markets": [], "limits": [] } }
}
```

## Reloading policies (hot reload)

When started with a policy file path:

- the policy file is watched for changes
- when changed, the broker reloads the policy and **restarts the gRPC server** to apply it

Operational note: this restart may briefly interrupt in-flight requests.

---

## Withdraw policy (`withdraw.rule`)

Withdraw requests are rejected unless all of the below pass.

### `withdraw.rule: WithdrawRuleEntry[]`

**Required.** Must contain at least one entry.

Each entry scopes a set of withdrawal permissions to an `exchange` + `network` combination. When a withdraw request arrives, the broker finds the highest-priority matching rule entry and validates the destination address against that entry.

#### Rule matching priority

When multiple entries match a request, the broker selects the single highest-priority entry:

| Priority | `exchange` | `network` | Description |
|----------|-----------|-----------|-------------|
| 4 (highest) | exact match | exact match | Fully specific rule |
| 3 | exact match | `"*"` | Exchange-specific, any network |
| 2 | `"*"` | exact match | Network-specific, any exchange |
| 1 (lowest) | `"*"` | `"*"` | Global catch-all |

If no entry matches, the request is rejected.

---

### `withdraw.rule[].exchange`

| | |
|---|---|
| **Type** | `string` |
| **Required** | Yes |
| **Normalisation** | Trimmed, uppercased |

Accepted values:

- **An exchange identifier** — e.g. `"BINANCE"`, `"KRAKEN"`, `"BYBIT"`. Must correspond to a supported CCXT exchange.
- **`"*"`** — wildcard; matches any exchange.

---

### `withdraw.rule[].network`

| | |
|---|---|
| **Type** | `string` |
| **Required** | Yes |
| **Normalisation** | Trimmed, uppercased |

Accepted values:

- **A network/chain identifier** — e.g. `"ARBITRUM"`, `"BEP20"`, `"ETH"`, `"SOL"`. The value must match what the exchange uses for that chain.
- **`"*"`** — wildcard; matches any network.

Even if the policy allows a network, the selected exchange must also support that network for the currency or the request will still fail at execution time.

---

### `withdraw.rule[].whitelist`

| | |
|---|---|
| **Type** | `string[]` |
| **Required** | Yes (may be empty, but that would reject all addresses) |
| **Normalisation** | Each entry is trimmed and lowercased |

Accepted values:

- An array of destination addresses (e.g. `"0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"`).
- Matching is **exact** after both the policy value and the incoming address are lowercased.
- Recommendation: store all addresses in lowercase in the JSON for readability and diffs.

---

### `withdraw.rule[].coins`

| | |
|---|---|
| **Type** | `string[]` |
| **Required** | No |
| **Normalisation** | Each entry is trimmed, uppercased |

Optional array of CEX ticker symbols that are allowed for withdrawal under this rule.

Accepted values:

- **An array of ticker symbols** — e.g. `["ETH", "USDT", "USDC", "ARB"]`. Only these tokens may be withdrawn when this rule matches.
- **`["*"]`** — wildcard; allows any token (same as omitting the field).
- **Omitted / not present** — allows any token (backward compatible with rules written before `coins` was added).

Matching is **case-insensitive** — both the policy value and the request ticker are uppercased before comparison.

---

### Full withdraw example

```json
{
  "withdraw": {
    "rule": [
      {
        "exchange": "BINANCE",
        "network": "ARBITRUM",
        "coins": ["ETH", "USDT", "USDC", "ARB"],
        "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"]
      },
      {
        "exchange": "BINANCE",
        "network": "*",
        "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"]
      },
      {
        "exchange": "*",
        "network": "BEP20",
        "coins": ["BNB", "USDT"],
        "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"]
      },
      {
        "exchange": "*",
        "network": "*",
        "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"]
      }
    ]
  }
}
```

In this example, a BINANCE + ARBITRUM withdraw uses the first rule (priority 4) and only allows ETH, USDT, USDC, and ARB. A BINANCE + SOL withdraw falls to the second rule (priority 3), which has no `coins` restriction — any token is allowed. A KRAKEN + BEP20 withdraw uses the third rule (priority 2) and is restricted to BNB and USDT. Everything else hits the global catch-all (priority 1), which also allows any token.

Common rejection reasons:

- no matching exchange + network entry
- address not whitelisted
- token not in `coins` for the matched rule

---

## Order policy (`order.rule`)

Order creation is rejected unless all of the below pass:

1. **Market rule match**: `markets` contains at least one pattern that matches the requested exchange + pair
2. **Exchange symbol support**: the exchange supports either `FROM/TO` or `TO/FROM`
3. **Limits (optional)**: if `limits` is present and non-empty, the requested conversion direction exists and the requested amount is within min/max

---

### `order.rule.markets`

| | |
|---|---|
| **Type** | `string[]` |
| **Required** | Yes |
| **Normalisation** | Each entry is trimmed, uppercased |

Market pattern formats:

| Pattern | Example | Matches |
|---------|---------|---------|
| `"*"` | `"*"` | Any exchange, any pair |
| `"<EXCHANGE>:*"` | `"BINANCE:*"` | Any pair on the specified exchange |
| `"*:<BASE>/<QUOTE>"` | `"*:BTC/ETH"` | The specified pair on any exchange |
| `"<EXCHANGE>:<BASE>/<QUOTE>"` | `"BINANCE:ETH/USDT"` | The specified pair on the specified exchange |

Matching behaviour:

- **Case-insensitive** (both the pattern and the request are uppercased before comparison).
- Pair matching is **symmetric**: `BINANCE:BTC/ETH` matches requests for both `BTC→ETH` and `ETH→BTC`.
- Any pattern that does not contain a `:` separator (other than the bare `"*"`) is ignored.

Examples:

```json
{ "markets": ["*"] }
```

```json
{ "markets": ["BINANCE:*", "KRAKEN:ETH/USDT"] }
```

```json
{ "markets": ["*:BTC/ETH"] }
```

---

### `order.rule.limits`

| | |
|---|---|
| **Type** | `Array<{ from: string, to: string, min: number, max: number }>` |
| **Required** | No (defaults to `[]` if omitted) |

Optional directional conversion limits.

Each object in the array:

| Field | Type | Required | Normalisation | Description |
|-------|------|----------|---------------|-------------|
| `from` | `string` | Yes | Uppercased | Source token symbol, e.g. `"USDT"` |
| `to` | `string` | Yes | Uppercased | Destination token symbol, e.g. `"ETH"` |
| `min` | `number` | Yes | — | Inclusive lower bound on the `from` amount |
| `max` | `number` | Yes | — | Inclusive upper bound on the `from` amount |

Key behaviour:

- **If omitted or empty**, no amount or direction restrictions are applied — any matched market is allowed.
- **If non-empty**, each order must match a `from`/`to` entry for the requested direction. Unmatched directions are rejected.
- **Limits are directional**: `USDT→ETH` and `ETH→USDT` are separate entries. You must add both if you want to allow both directions.
- Limits apply to the request's **from amount** (the amount of `fromToken` the caller is converting), even if the broker flips the symbol direction for execution.
- If the exchange only supports the reverse symbol, the broker computes a base amount via `amount / price`; this requires `price > 0`.

Example:

```json
{
  "order": {
    "rule": {
      "markets": ["BINANCE:*"],
      "limits": [
        { "from": "USDT", "to": "ETH", "min": 1, "max": 100000 },
        { "from": "ETH", "to": "USDT", "min": 0.5, "max": 5 }
      ]
    }
  }
}
```

---

## Deposit policy (`deposit`)

| | |
|---|---|
| **Type** | `{ rule?: DepositRuleEntry[] }` |
| **Required** | Yes (the `deposit` key must be present) |

Deposit validation gates the `FetchDepositAddresses` action — a request to fetch a deposit address is rejected if the policy does not permit deposits for the given exchange, network, and token. The actual deposit confirmation is not gated by the policy (only the address fetch is).

### Backward compatibility

- **`"deposit": {}`** — no `rule` key or empty rule array: **all deposits are allowed**. This is backward compatible with policies written before deposit rules were added.
- **`"deposit": { "rule": [...] }`** — only deposits matching a rule are allowed.

---

### `deposit.rule: DepositRuleEntry[]`

**Optional.** When omitted or empty, all deposits are permitted.

Each entry scopes deposit permissions to an `exchange` + `network` combination, optionally restricted to specific tokens. When a `FetchDepositAddresses` request arrives, the broker finds the highest-priority matching rule and validates the token against it.

#### Rule matching priority

Same priority scheme as withdraw rules:

| Priority | `exchange` | `network` | Description |
|----------|-----------|-----------|-------------|
| 4 (highest) | exact match | exact match | Fully specific rule |
| 3 | exact match | `"*"` | Exchange-specific, any network |
| 2 | `"*"` | exact match | Network-specific, any exchange |
| 1 (lowest) | `"*"` | `"*"` | Global catch-all |

If rules are present but no entry matches, the request is rejected.

---

### `deposit.rule[].exchange`

| | |
|---|---|
| **Type** | `string` |
| **Required** | Yes |
| **Normalisation** | Trimmed, uppercased |

Same as `withdraw.rule[].exchange` — an exchange identifier (e.g. `"BINANCE"`) or `"*"` for wildcard.

---

### `deposit.rule[].network`

| | |
|---|---|
| **Type** | `string` |
| **Required** | Yes |
| **Normalisation** | Trimmed, uppercased |

Same as `withdraw.rule[].network` — a network/chain identifier (e.g. `"ARBITRUM"`) or `"*"` for wildcard.

---

### `deposit.rule[].coins`

| | |
|---|---|
| **Type** | `string[]` |
| **Required** | No |
| **Normalisation** | Each entry is trimmed, uppercased |

Optional array of CEX ticker symbols allowed for deposit under this rule. Behaves identically to `withdraw.rule[].coins`:

- **An array of ticker symbols** — e.g. `["ETH", "USDT"]`. Only these tokens may be deposited.
- **`["*"]`** — wildcard; allows any token (same as omitting the field).
- **Omitted / not present** — allows any token.

Matching is **case-insensitive**.

---

### Full deposit example

```json
{
  "deposit": {
    "rule": [
      {
        "exchange": "BINANCE",
        "network": "ARBITRUM",
        "coins": ["ETH", "USDT", "USDC", "ARB"]
      },
      {
        "exchange": "*",
        "network": "*"
      }
    ]
  }
}
```

In this example, a BINANCE + ARBITRUM deposit address request is matched by the first rule (priority 4) and is restricted to ETH, USDT, USDC, and ARB. Any other exchange/network combination hits the catch-all rule, which allows all tokens.

Common rejection reasons:

- deposit rules are present but no matching exchange + network entry
- token not in `coins` for the matched rule

---

## Validation & error handling

### Schema validation

The broker validates the policy JSON against a Joi schema when loading it.

- All top-level keys (`withdraw`, `deposit`, `order`) must be present.
- `withdraw.rule` must be a non-empty array (at least one entry).
- Every required field must be present and of the correct type.
- If validation fails, the policy load fails and the broker will not start (or will log an error on reload).

### Troubleshooting tips

- **Withdraw address rejected**: ensure the address is in the matching `withdraw.rule[].whitelist` entry (lowercase recommended).
- **Withdraw exchange/network rejected**: ensure there is a `withdraw.rule[]` entry whose `exchange` and `network` match (or wildcard-match) the request.
- **Withdraw token rejected**: ensure the matched `withdraw.rule[].coins` includes the token ticker (or omit `coins` to allow all).
- **Deposit address fetch rejected**: ensure `deposit.rule` contains a matching entry for the exchange + network + token, or use `"deposit": {}` to allow all.
- **Order rejected (market)**: ensure `order.rule.markets` contains a matching pattern for the exchange + pair.
- **Order rejected (limits)**: if `limits` is non-empty, ensure there's an entry for the exact `from` → `to` direction and the amount is within bounds.
