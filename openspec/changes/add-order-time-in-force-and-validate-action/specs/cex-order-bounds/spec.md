## ADDED Requirements

### Requirement: Orders state their time in force
`CreateOrder` SHALL accept an optional `timeInForce` of `GTC`, `IOC`, `FOK` or `PO`, validate it against the order type and the venue's support before any venue call, and pass it to the venue.

#### Scenario: Immediate-or-cancel limit order
- **WHEN** a limit order is submitted with `timeInForce: IOC`
- **THEN** the venue receives an immediate-or-cancel limit order and any unfilled remainder is cancelled by the venue

#### Scenario: Unsupported combination
- **WHEN** a market order is submitted with `timeInForce: FOK`
- **THEN** the action fails with `INVALID_ARGUMENT` and no venue method is called

#### Scenario: Omitted time in force
- **WHEN** an order omits `timeInForce`
- **THEN** it behaves exactly as before this change

### Requirement: Orders can be found by client order id
`GetOrderDetails` SHALL accept exactly one of `orderId` or `clientOrderId` and resolve a client order id through the venue's native lookup.

#### Scenario: Recovery after a crash
- **WHEN** a client submitted an order with client order id X and asks for `clientOrderId: X`
- **THEN** the broker returns that order's details

#### Scenario: Venue without client order id lookup
- **WHEN** the venue offers no lookup by client order id
- **THEN** the action fails with `FAILED_PRECONDITION` and reason `client_order_lookup_unsupported`

### Requirement: Actions can be validated without being placed
`ValidateAction` SHALL check an order, withdrawal or deposit-address request against policy, market limits and precision, and venue capabilities, and SHALL call no mutating venue method.

#### Scenario: Below the exchange minimum
- **WHEN** an order below the market's minimum amount is validated
- **THEN** the result lists the minimum as a refusal reason and nothing is placed

#### Scenario: Valid action
- **WHEN** a valid withdrawal to a whitelisted address is validated
- **THEN** the result carries the normalized action and no refusal reasons, and no withdrawal is made

### Requirement: gRPC bind host is configurable
The broker SHALL accept a bare IPv4 or IPv6 address as the gRPC bind host through `--bind-host` or `CEX_BROKER_GRPC_BIND_HOST`. The CLI flag SHALL take precedence. The broker SHALL reject an invalid selected value and SHALL default to `0.0.0.0` when neither setting is present. The bind host SHALL NOT change the IP allowlist.

#### Scenario: Bind to loopback only
- **WHEN** the selected bind host is `127.0.0.1` or `::1`
- **THEN** the gRPC server listens only on that loopback address
