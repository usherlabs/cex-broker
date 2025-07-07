# FietCexBroker

A high-performance gRPC-based cryptocurrency exchange broker service that provides unified access to multiple centralized exchanges (CEX) including Binance and Bybit. Built with TypeScript, Bun, and CCXT for reliable trading operations.

## Features

- **Multi-Exchange Support**: Unified API for Binance and Bybit
- **gRPC Interface**: High-performance RPC communication
- **Real-time Pricing**: Optimal price discovery across exchanges
- **Balance Management**: Real-time balance checking
- **Policy Enforcement**: Configurable trading and withdrawal limits
- **IP Authentication**: Security through IP whitelisting
- **Type Safety**: Full TypeScript support with generated protobuf types

## Prerequisites

- [Bun](https://bun.sh) (v1.2.17 or higher)
- Node.js (v18 or higher) - for TypeScript support
- API keys for supported exchanges (Binance, Bybit)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd fietCexBroker
```

2. Install dependencies:
```bash
bun install
```

3. Generate protobuf types:
```bash
bun run proto-gen
```

## Configuration

### Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Server Configuration
PORT_NUM=8082

# Exchange API Keys
BINANCE_API_KEY=your_binance_api_key
BINANCE_API_SECRET=your_binance_api_secret
BYBIT_API_KEY=your_bybit_api_key
BYBIT_API_SECRET=your_bybit_api_secret

# Supported Brokers (optional, defaults to BINANCE,BYBIT)
ROOCH_CHAIN_ID=BINANCE,BYBIT
```

### Policy Configuration

Configure trading policies in `policy/policy.json`:

```json
{
  "withdraw": {
    "rule": {
      "networks": ["ARB"],
      "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
      "amounts": {
        "ticker": "USDC",
        "max": 100000,
        "min": 1
      }
    }
  },
  "deposit": {},
  "order": {
    "rule": {
      "markets": ["BINANCE:ARB/USDT", "BYBIT:ARB/USDC"],
      "limits": [
        { "from": "USDT", "to": "ETH", "min": 1, "max": 100000 },
        { "from": "ETH", "to": "USDT", "min": 0.5, "max": 5 }
      ]
    }
  }
}
```

## Usage

### Starting the Server

```bash
# Development
bun run start

# Production build
bun run build
bun run ./build/index.js
```

### Available Scripts

```bash
# Start the server
bun run start

# Build for production
bun run build

# Run tests
bun test

# Run tests with coverage
bun test --coverage

# Generate protobuf types
bun run proto-gen
```

## API Reference

The service exposes a gRPC interface with the following methods:

### GetOptimalPrice

Get optimal buy/sell prices across supported exchanges.

**Request:**
```protobuf
message OptimalPriceRequest {
  string symbol = 1;            // Trading pair symbol, e.g. "ARB/USDT"
  double quantity = 2;          // Quantity to buy or sell
  OrderMode mode = 3;           // Buy (0) or Sell (1) mode
}
```

**Response:**
```protobuf
message OptimalPriceResponse {
  map<string, PriceInfo> results = 1;
}

message PriceInfo {
  double avgPrice = 1;          // Volume-weighted average price
  double fillPrice = 2;         // Worst-case fill price
}
```

**Example:**
```typescript
const request = {
  symbol: "ARB/USDT",
  quantity: 100,
  mode: 0  // BUY
};
```

### GetBalance

Get available balance for a specific currency on a specific exchange.

**Request:**
```protobuf
message BalanceRequest {
  string cex_key = 1;          // CEX identifier (e.g., "BINANCE", "BYBIT")
  string symbol = 2;           // Trading pair symbol, e.g. "ARB/USDT"
}
```

**Response:**
```protobuf
message BalanceResponse {
  double balance = 1;          // Available balance for the symbol
  string currency = 2;         // Currency of the balance
}
```

**Example:**
```typescript
const request = {
  cex_key: "BINANCE",
  symbol: "ARB/USDT"
};
```

### Deposit

Confirm a deposit transaction.

**Request:**
```protobuf
message DepositConfirmationRequest {
  string chain = 1;
  string recipient_address = 2;
  double amount = 3;
  string transaction_hash = 4;
}
```

**Response:**
```protobuf
message DepositConfirmationResponse {
  double new_balance = 1;
}
```

### Transfer

Execute a transfer/withdrawal.

**Request:**
```protobuf
message TransferRequest {
  string chain = 1;
  string recipient_address = 2;
  double amount = 3;
}
```

**Response:**
```protobuf
message TransferResponse {
  bool success = 1;
  double new_balance = 2;
}
```

### Convert

Convert between different tokens.

**Request:**
```protobuf
message ConvertRequest {
  string from_token = 1;
  string to_token = 2;
  double amount = 3;
}
```

**Response:**
```protobuf
message ConvertResponse {
  double received_amount = 1;
  double new_balance = 2;
}
```

## Security

### IP Authentication

All API calls require IP authentication. Configure allowed IPs in your policy or security layer.

### API Key Management

- Store API keys securely in environment variables
- Use read-only API keys when possible
- Regularly rotate API keys
- Monitor API usage and set appropriate rate limits

## Error Handling

The service returns appropriate gRPC status codes:

- `INVALID_ARGUMENT`: Missing or invalid parameters
- `PERMISSION_DENIED`: IP not allowed or policy violation
- `NOT_FOUND`: Resource not found (e.g., currency balance)
- `INTERNAL`: Server error

## Development

### Project Structure

```
fietCexBroker/
├── config/                 # Configuration files
│   ├── broker.ts          # Exchange broker setup
│   └── index.ts           # Environment configuration
├── helpers/               # Utility functions
├── policy/                # Policy configuration
├── proto/                 # Protocol buffer definitions
│   ├── fietCexNode/       # Generated TypeScript types
│   └── node.proto         # Service definition
├── index.ts               # Main server file
├── types.ts               # TypeScript type definitions
└── package.json           # Dependencies and scripts
```

### Adding New Exchanges

1. Add the exchange to `types.ts` in the `BrokerList`
2. Configure API keys in `config/index.ts`
3. Initialize the broker in `config/broker.ts`
4. Update policy configuration if needed

### Testing

```bash
# Run all tests
bun test

# Run tests with watch mode
bun test --watch

# Run tests with coverage
bun test --coverage
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## License

[Add your license information here]

## Support

For issues and questions, please open an issue on the repository or contact the development team.
