# CEX Broker

A high-performance gRPC-based cryptocurrency exchange broker service that provides unified access to multiple centralized exchanges (CEX) including Binance and Bybit. Built with TypeScript, Bun, and CCXT for reliable trading operations.

## Features

- **Multi-Exchange Support**: Unified API to any CEX supported by [CCXT](https://github.com/ccxt/ccxt)
- **gRPC Interface**: High-performance RPC communication
- **Real-time Pricing**: Optimal price discovery across exchanges
- **Balance Management**: Real-time balance checking
- **Order Management**: Create, track, and cancel orders
- **Transfer Operations**: Withdraw funds to external addresses
- **Token Conversion**: Convert between different tokens
- **Policy Enforcement**: Configurable trading and withdrawal limits
- **IP Authentication**: Security through IP whitelisting
- **Type Safety**: Full TypeScript support with generated protobuf types

## Prerequisites

- [Bun](https://bun.sh) (v1.2.17 or higher)
- API keys for supported exchanges (Binance, Bybit)

## Installation

1. Clone the repository:
   
```bash
git clone <repository-url>
cd cex-broker
```

1. Install dependencies:
  
```bash
bun install
```

1. Generate protobuf types:
   
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

**Note**: API keys are only required for the exchanges you plan to use. The system will validate that required keys are provided based on the `ROOCH_CHAIN_ID` configuration.

### Policy Configuration

Configure trading policies in `policy/policy.json`:

```json
{
  "withdraw": {
    "rule": {
      "networks": ["BEP20", "ARBITRUM"],
      "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
      "amounts": [
        {
          "ticker": "USDC",
          "max": 100000,
          "min": 1
        },
        {
          "ticker": "USDT",
          "max": 100000,
          "min": 1
        }
      ]
    }
  },
  "deposit": {},
  "order": {
    "rule": {
      "markets": [
        "BINANCE:ARB/USDT",
        "BYBIT:ARB/USDC",
        "BINANCE:ETH/USDT",
        "BINANCE:BTC/ETH"
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

# Generate protobuf types
bun run proto-gen

# Format code
bun run format

# Lint code
bun run lint

# Check code (format + lint)
bun run check
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
  string cex = 1;              // CEX identifier (e.g., "BINANCE", "BYBIT")
  string token = 2;            // Token symbol, e.g. "USDT"
}
```

**Response:**

```protobuf
message BalanceResponse {
  double balance = 1;          // Available balance for the token
  string currency = 2;         // Currency of the balance
}
```

**Example:**

```typescript
const request = {
  cex: "BINANCE",
  token: "USDT"
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
  double newBalance = 1;
}
```

### Transfer

Execute a transfer/withdrawal to an external address.

**Request:**

```protobuf
message TransferRequest {
  string chain = 1;            // Network chain (e.g., "ARBITRUM", "BEP20")
  string recipient_address = 2; // Destination address
  double amount = 3;           // Amount to transfer
  string cex = 4;              // CEX identifier
  string token = 5;            // Token symbol
}
```

**Response:**

```protobuf
message TransferResponse {
  bool success = 1;
  string transaction_id = 2;
}
```

### Convert

Convert between different tokens using limit orders.

**Request:**

```protobuf
message ConvertRequest {
  string from_token = 1;       // Source token
  string to_token = 2;         // Destination token
  double amount = 3;           // Amount to convert
  double price = 4;            // Limit price
  string cex = 5;              // CEX identifier
}
```

**Response:**

```protobuf
message ConvertResponse {
  string order_id = 3;
}
```

### GetOrderDetails

Get details of a specific order.

**Request:**

```protobuf
message OrderDetailsRequest {
  string order_id = 1;         // Unique order identifier
  string cex = 2;              // CEX identifier
}
```

**Response:**

```protobuf
message OrderDetailsResponse {
  string order_id = 1;         // Unique order identifier
  string status = 2;           // Current order status
  double original_amount = 3;  // Original order amount
  double filled_amount = 4;    // Amount that has been filled
  string symbol = 5;           // Trading pair symbol
  string mode = 6;             // Buy or Sell mode
  double price = 7;            // Order price
}
```

### CancelOrder

Cancel an existing order.

**Request:**

```protobuf
message CancelOrderRequest {
  string order_id = 1;         // Unique order identifier
  string cex = 2;              // CEX identifier
}
```

**Response:**

```protobuf
message CancelOrderResponse {
  bool success = 1;            // Whether cancellation was successful
  string final_status = 2;     // Final status of the order
}
```

## Security

### IP Authentication

All API calls require IP authentication. Configure allowed IPs in `helpers/index.ts`:

```typescript
const ALLOWED_IPS = [
  "127.0.0.1", // localhost
  "::1",       // IPv6 localhost
  // Add your allowed IP addresses here
];
```

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
│   └── index.ts           # Core helper functions
├── policy/                # Policy configuration
│   └── policy.json        # Trading and withdrawal rules
├── proto/                 # Protocol buffer definitions
│   ├── fietCexNode/       # Generated TypeScript types
│   ├── node.proto         # Service definition
│   └── node.ts            # Type exports
├── scripts/               # Build scripts
│   └── patch-protobufjs.js
├── index.ts               # Main server file
├── types.ts               # TypeScript type definitions
├── proto-gen.sh           # Protobuf generation script
├── biome.json             # Code formatting/linting config
├── bunfig.toml            # Bun configuration
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

## Dependencies

### Core Dependencies

- `@grpc/grpc-js`: gRPC server implementation
- `@grpc/proto-loader`: Protocol buffer loading
- `ccxt`: Cryptocurrency exchange library
- `dotenv`: Environment variable management
- `joi`: Configuration validation

### Development Dependencies

- `@biomejs/biome`: Code formatting and linting
- `@types/bun`: Bun type definitions
- `bun-types`: Additional Bun types
- `husky`: Git hooks

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Run `bun run check` to format and lint code
7. Submit a pull request

## License

[Add your license information here]

## Support

For issues and questions, please open an issue on the repository or contact the development team.
