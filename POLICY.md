## Policy configuration (`policy.json`)

This broker uses a JSON policy file to restrict:

- **Withdrawals**: permitted exchanges, networks, and destination address whitelist
- **Orders**: permitted exchanges/pairs, plus optional directional conversion limits

The policy is loaded at startup. If you start the broker with a **policy file path**, the file is watched and policies are reloaded when the file changes.

## Quick start

- **Example policy**: `policy/policy.json`
- **CLI usage**:

```bash
bun run start-broker --policy policy/policy.json --port 8086 --whitelist 127.0.0.1
```

## File shape

Top-level keys (all required):

| Key | Type | Description |
|-----|------|-------------|
| `withdraw` | `{ rule: WithdrawRuleEntry[] }` | Withdrawal restrictions (at least one rule entry required) |
| `deposit` | `{}` | Placeholder object — not enforced today |
| `order` | `{ rule: OrderRule }` | Order/conversion restrictions |

Canonical type: `PolicyConfig` in `src/types.ts`.

```json
{
  "withdraw": {
    "rule": [
      { "exchange": "BINANCE", "network": "ARBITRUM", "whitelist": [] }
    ]
  },
  "deposit": {},
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

### Full withdraw example

```json
{
  "withdraw": {
    "rule": [
      {
        "exchange": "BINANCE",
        "network": "ARBITRUM",
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

In this example, a BINANCE + ARBITRUM withdraw uses the first rule (priority 4). A BINANCE + SOL withdraw falls to the second rule (priority 3). A KRAKEN + BEP20 withdraw uses the third rule (priority 2). Everything else hits the global catch-all (priority 1).

Common rejection reasons:

- no matching exchange + network entry
- address not whitelisted

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
| **Type** | `{}` (empty object) |
| **Required** | Yes |

`deposit` is required in the current policy schema, but it is **not enforced** today.

At present, deposits are effectively always allowed; this field is reserved for future deposit rule support. Set it to `{}`.

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
- **Order rejected (market)**: ensure `order.rule.markets` contains a matching pattern for the exchange + pair.
- **Order rejected (limits)**: if `limits` is non-empty, ensure there's an entry for the exact `from` → `to` direction and the amount is within bounds.
