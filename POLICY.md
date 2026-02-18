## Policy configuration (`policy.json`)

This broker uses a JSON policy file to restrict:

- **Withdrawals**: permitted networks, destination address whitelist, and per-token amounts
- **Orders**: permitted exchanges/pairs, plus optional directional conversion limits

The policy is loaded at startup. If you start the broker with a **policy file path**, the file is watched and policies are reloaded when the file changes.

## Quick start

- **Example policy**: `policy/policy.json`
- **CLI usage**:

```bash
bun run start-broker --policy policy/policy.json --port 8086 --whitelist 127.0.0.1
```

## File shape

Top-level keys (required):

- **`withdraw`**
- **`deposit`** (currently a placeholder; not enforced)
- **`order`**

Canonical type: `PolicyConfig` in `src/types.ts`.

```json
{
  "withdraw": { "rule": { "networks": [], "whitelist": [], "amounts": [] } },
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

### `withdraw.rule.networks: string[]`

Allowed withdrawal networks/chains (e.g. `"ARBITRUM"`, `"BEP20"`).

- **Matching is case-insensitive** (the broker normalises both policy networks and request chains before comparison).
- **Exchange support is checked separately**: even if policy allows a network, the selected exchange must also support that network for the currency, or the request will still fail later.

### `withdraw.rule.whitelist: string[]`

Allowed destination addresses.

- **The broker lowercases policy whitelist entries and the incoming address**.
- Recommendation: store all whitelist addresses in lowercase in the JSON for readability and diffs.

### `withdraw.rule.amounts: Array<{ ticker, min, max }>`

Per-token withdrawal bounds.

- **`ticker` match is case-insensitive** (normalised to uppercase).
- `min`/`max` are inclusive bounds on the requested withdrawal amount.

Example:

```json
{
  "withdraw": {
    "rule": {
      "networks": ["ARBITRUM", "BEP20"],
      "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
      "amounts": [
        { "ticker": "USDC", "min": 1, "max": 100000 },
        { "ticker": "USDT", "min": 1, "max": 100000 }
      ]
    }
  }
}
```

Common rejection reasons:

- network not allowed
- address not whitelisted
- ticker not allowed
- amount below min / above max

---

## Order policy (`order.rule`)

Order creation is rejected unless all of the below pass:

1. **Market rule match**: `markets` contains at least one pattern that matches the requested exchange + pair
2. **Exchange symbol support**: the exchange supports either `FROM/TO` or `TO/FROM`
3. **Limits (optional)**: if `limits` is present and non-empty, the requested conversion direction exists and the requested amount is within min/max

### `order.rule.markets: string[]`

Market patterns have the form:

- `"*"`: allow any exchange and any pair
- `"<EXCHANGE>:*"`: allow any pair on a specific exchange
- `"*:<BASE>/<QUOTE>"`: allow a specific pair on any exchange
- `"<EXCHANGE>:<BASE>/<QUOTE>"`: allow a specific pair on a specific exchange

Matching behaviour:

- **Case-insensitive**
- Pair matching is **symmetric**: `BINANCE:BTC/ETH` matches both `BTC/ETH` and `ETH/BTC`

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

### `order.rule.limits?: Array<{ from, to, min, max }>`

Optional conversion limits. Limits are **directional**:

- If omitted or an empty array, conversions are not restricted by limits.
- If non-empty, each order must match a `from`/`to` entry, and the requested `amount` must be within \([min, max]\).

Important:

- Limits apply to the request’s **from amount** (the amount of `fromToken` the caller is converting), even if execution flips the symbol direction.
- If the exchange only supports the reverse symbol direction, the broker may need to compute a base amount using `amount / price`; this requires `price > 0`.

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

`deposit` is required in the current policy schema, but it is **not enforced** today.

At present, deposits are effectively always allowed; this field is reserved for future deposit rule support.

---

## Validation & error handling

### Schema validation

The broker validates the policy JSON against a schema when loading it.

- If validation fails, the policy load fails and the broker will not start (or will log an error on reload).

### Troubleshooting tips

- **Withdraw address rejected**: ensure the address is in `withdraw.rule.whitelist` (lowercase recommended).
- **Withdraw network rejected**: ensure the request `chain` is listed in `withdraw.rule.networks`.
- **Ticker rejected**: ensure `withdraw.rule.amounts[].ticker` includes the currency symbol you’re withdrawing.
- **Order rejected (market)**: ensure `order.rule.markets` contains a matching pattern.
- **Order rejected (limits)**: if `limits` is non-empty, ensure there’s an entry for the exact `from` → `to` direction and the amount is within bounds.
