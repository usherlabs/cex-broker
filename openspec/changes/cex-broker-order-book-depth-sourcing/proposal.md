## Why

Fiet Maker HB strategy backtests now expect cex-broker to provide order-book depth through broker-compatible typed operations instead of relying only on direct provider fallbacks. The broker currently exposes live `Subscribe(ORDERBOOK)` and generic CCXT `Call`, but it does not define HB-compatible order-book capability, current snapshot, or historical snapshot result contracts.

## What Changes

- Add HB-compatible JSON-over-`Action.Call` order-book methods:
  - `fetch_order_book_capability`
  - `fetch_order_book_snapshot`
  - `fetch_historical_order_book_snapshots`
- Normalize current and live order-book payloads with bids, asks, source timestamp, broker received timestamp, exchange, symbol, sequence/update id when available, and requested depth limit.
- Return typed unsupported historical responses for unavailable historical depth instead of transport failures or empty streams.
- Preserve backward compatibility for existing `Subscribe(ORDERBOOK)` clients, including old/default subscription-type behavior and existing JSON `bids`/`asks` payload shape.
- Report truthful provider capabilities for current snapshots, live streams, sampled top-N historical snapshots, and exact L2 reconstruction.
- Keep exact L2 reconstruction unsupported until the broker implements snapshot-plus-delta reconstruction with sequence-continuity validation.
- Keep venue selection strict: responses must reflect the requested exchange and symbol and must not silently substitute another exchange.

## Capabilities

### New Capabilities

- `cex-broker-order-book-depth-sourcing`: Defines broker order-book capability discovery, current snapshot fetches, live stream metadata compatibility, historical snapshot success/unsupported responses, and provider truthfulness for Fiet Maker HB compatibility.

### Modified Capabilities

- None.

## Impact

- Affected broker API surfaces:
  - `ExecuteAction(Action.Call)` payload parsing and dispatch
  - `Subscribe(ORDERBOOK)` response normalization
  - broker capability/result JSON contracts consumed by Maker Python helpers
- Affected files likely include:
  - `src/server.ts`
  - `src/schemas/action-payloads.ts`
  - `src/helpers/constants.ts`
  - `src/proto/node.proto` and generated descriptor artifacts if proto comments or typed additions change
  - `README.md` and order-book examples
  - broker tests for Call payload compatibility, typed unsupported responses, live stream backward compatibility, and capability truthfulness
- No raw credentials, API secrets, or provider authentication metadata should be emitted in order-book response payloads.
