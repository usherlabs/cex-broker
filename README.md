# CEX Broker

A high-performance gRPC-based cryptocurrency exchange broker service that provides unified access to multiple centralized exchanges (CEX) through the CCXT library. Built with TypeScript, Bun, and designed for reliable trading operations with policy enforcement, real-time streaming, and zero-knowledge proof integration.

## 🚀 Features

- **Multi-Exchange Support**: Unified API to any CEX supported by [CCXT](https://github.com/ccxt/ccxt) (100+ exchanges)
- **gRPC Interface**: High-performance RPC communication with type safety
- **Real-time Streaming**: Live orderbook, trades, ticker, OHLCV, balance, and order updates
- **Policy Enforcement**: Configurable trading and withdrawal limits with real-time policy updates
- **IP Authentication**: Security through IP whitelisting
- **Zero-Knowledge Proofs**: Optional Verity integration for privacy-preserving operations
- **Secondary Broker Support**: Multiple API keys per exchange for load balancing and redundancy
- **Real-time Policy Updates**: Hot-reload policy changes without server restart
- **Type Safety**: Full TypeScript support with generated protobuf types
- **Comprehensive Logging**: Built-in logging with tslog
- **CLI Support**: Command-line interface for easy management
- **Deposit Address Management**: Fetch deposit addresses for supported networks
- **Advanced Order Management**: Create, fetch, and cancel orders with full details

## 📋 Prerequisites

- [Bun](https://bun.sh) (v1.2.17 or higher)
- API keys for supported exchanges (e.g., Binance, Bybit, etc.)
- Optional: Verity prover URL for zero-knowledge proof integration

## 🛠️ Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd fietCexBroker
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Generate protobuf types:**
   ```bash
   bun run proto-gen
   ```

## ⚙️ Configuration

### Environment Variables

The broker loads configuration from environment variables with the `CEX_BROKER_` prefix:

```env
# Server Configuration
PORT_NUM=8086

# Primary Exchange API Keys (format: CEX_BROKER_<EXCHANGE>_API_KEY/SECRET)
CEX_BROKER_BINANCE_API_KEY=your_binance_api_key
CEX_BROKER_BINANCE_API_SECRET=your_binance_api_secret
CEX_BROKER_BYBIT_API_KEY=your_bybit_api_key
CEX_BROKER_BYBIT_API_SECRET=your_bybit_api_secret
CEX_BROKER_KRAKEN_API_KEY=your_kraken_api_key
CEX_BROKER_KRAKEN_API_SECRET=your_kraken_api_secret

# Secondary Exchange API Keys (for load balancing and redundancy)
CEX_BROKER_BINANCE_API_KEY_1=your_secondary_binance_api_key
CEX_BROKER_BINANCE_API_SECRET_1=your_secondary_binance_api_secret
CEX_BROKER_BINANCE_API_KEY_2=your_tertiary_binance_api_key
CEX_BROKER_BINANCE_API_SECRET_2=your_tertiary_binance_api_secret
```

**Note**: Only configure API keys for exchanges you plan to use. The system will automatically detect and initialize configured exchanges.

### Policy Configuration

Configure trading policies in `policy/policy.json`:

```json
{
  "withdraw": {
    "rule": {
      "networks": ["BEP20", "ARBITRUM", "ETHEREUM"],
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

## 🚀 Usage

### Starting the Server

```bash
# Using the CLI (recommended)
bun run start-broker --policy policy/policy.json --port 8086 --whitelist 127.0.0.1 192.168.1.100 --verityProverUrl http://localhost:8080

# Development mode
bun run start

# Production build
bun run build:ts
bun run ./build/index.js
```

### CLI Options

```bash
cex-broker --help

Options:
  -p, --policy <path>                    Policy JSON file (required)
  --port <number>                        Port number (default: 8086)
  -w, --whitelist <addresses...>         IPv4 address whitelist (space-separated list)
  -vu, --verityProverUrl <url>           Verity Prover URL for zero-knowledge proofs
```

### Available Scripts

```bash
# Start the server
bun run start

# Build for production
bun run build:ts

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

## 📡 API Reference

The service exposes a gRPC interface with two main methods:

### ExecuteAction

Execute trading operations on supported exchanges.

**Request:**
```protobuf
message ActionRequest {
  Action action = 1;                        // The action to perform
  map<string, string> payload = 2;          // Parameters for the action
  string cex = 3;                           // CEX identifier (e.g., "binance", "bybit")
  string symbol = 4;                        // Trading pair symbol if needed
}
```

**Response:**
```protobuf
message ActionResponse {
  string result = 2;                        // JSON string of the result data or ZK proof
}
```

**Available Actions:**
- `NoAction` (0): No operation
- `Deposit` (1): Confirm deposit transaction
- `Transfer` (2): Transfer/withdraw funds
- `CreateOrder` (3): Create a new order
- `GetOrderDetails` (4): Get order information
- `CancelOrder` (5): Cancel an existing order
- `FetchBalance` (6): Get account balance
- `FetchDepositAddresses` (7): Get deposit addresses for a token/network

**Example Usage:**

```typescript
// Fetch balance
const balanceRequest = {
  action: 6, // FetchBalance
  payload: {},
  cex: "binance",
  symbol: "USDT"
};

// Create order
const orderRequest = {
  action: 3, // CreateOrder
  payload: {
    orderType: "limit",
    amount: "0.001",
    fromToken: "BTC",
    toToken: "USDT",
    price: "50000"
  },
  cex: "binance",
  symbol: "BTC/USDT"
};

// Fetch deposit addresses
const depositAddressRequest = {
  action: 7, // FetchDepositAddresses
  payload: {
    chain: "BEP20"
  },
  cex: "binance",
  symbol: "USDT"
};
```

### Subscribe (Streaming)

Real-time streaming of market data and account updates.

**Request:**
```protobuf
message SubscribeRequest {
  string cex = 1;                          // CEX identifier
  string symbol = 2;                        // Trading pair symbol
  SubscriptionType type = 3;                // Type of subscription
  map<string, string> options = 4;          // Additional options (e.g., timeframe)
}
```

**Response Stream:**
```protobuf
message SubscribeResponse {
  string data = 1;                         // JSON string of the streaming data
  int64 timestamp = 2;                     // Unix timestamp
  string symbol = 3;                       // Trading pair symbol
  SubscriptionType type = 4;               // Type of subscription
}
```

**Available Subscription Types:**
- `ORDERBOOK` (0): Real-time order book updates
- `TRADES` (1): Live trade feed
- `TICKER` (2): Ticker information updates
- `OHLCV` (3): Candlestick data (configurable timeframe)
- `BALANCE` (4): Account balance updates
- `ORDERS` (5): Order status updates

**Example Usage:**

```typescript
// Subscribe to orderbook updates
const orderbookRequest = {
  cex: "binance",
  symbol: "BTC/USDT",
  type: 0, // ORDERBOOK
  options: {}
};

// Subscribe to OHLCV with custom timeframe
const ohlcvRequest = {
  cex: "binance",
  symbol: "BTC/USDT",
  type: 3, // OHLCV
  options: {
    timeframe: "1h"
  }
};
```

## 🔒 Security

### IP Authentication

All API calls require IP authentication. Configure allowed IPs via CLI or broker initialization:

```bash
# Via CLI
cex-broker --policy policy.json --whitelist 127.0.0.1 192.168.1.100

# Via code
const config = {
  port: 8086,
  whitelistIps: [
    "127.0.0.1", // localhost
    "::1",       // IPv6 localhost
    "192.168.1.100", // Your allowed IP
  ]
};
```

### Secondary Broker Support

For high-availability, load balancing and compartmentalized capital management, **you can configure multiple API keys per exchange**:

```env
# Primary keys
CEX_BROKER_BINANCE_API_KEY=primary_key
CEX_BROKER_BINANCE_API_SECRET=primary_secret

# Secondary keys (numbered)
CEX_BROKER_BINANCE_API_KEY_1=secondary_key_1
CEX_BROKER_BINANCE_API_SECRET_1=secondary_secret_1
CEX_BROKER_BINANCE_API_KEY_2=secondary_key_2
CEX_BROKER_BINANCE_API_SECRET_2=secondary_secret_2
```

To use secondary brokers, include the `use-secondary-key` metadata in your gRPC calls:

```typescript
const metadata = new grpc.Metadata();
metadata.set('use-secondary-key', '1'); // Use secondary broker 1
metadata.set('use-secondary-key', '2'); // Use secondary broker 2
```

### Zero-Knowledge Proof Integration

**Enable privacy-preserving proof over CEX data** with [Verity zkTLS integration](https://github.com/usherlabs/verity-dp):

```bash
# Start with Verity integration
cex-broker --policy policy.json --verityProverUrl http://localhost:8080
```

When Verity is enabled, responses include zero-knowledge proofs instead of raw data:

```typescript
// With Verity enabled
const response = await client.ExecuteAction(request, metadata);
// response.result contains ZK proof instead of raw data
```

### API Key Management

- Store API keys securely in environment variables
- Use read-only API keys when possible
- Regularly rotate API keys
- Monitor API usage and set appropriate rate limits
- Use secondary brokers for redundancy and load distribution

## 🏗️ Architecture

### Project Structure

```
fietCexBroker/
├── src/                    # Source code
│   ├── commands/          # CLI commands
│   │   └── start-broker.ts # Broker startup command
│   ├── helpers/           # Utility functions
│   │   ├── index.ts       # Policy validation helpers
│   │   └── logger.ts      # Logging configuration
│   ├── index.ts           # Main broker class
│   ├── server.ts          # gRPC server implementation
│   ├── cli.ts             # CLI entry point
│   └── types.ts           # TypeScript type definitions
├── proto/                 # Protocol buffer definitions
│   ├── node.proto         # Service definition
│   └── node.ts            # Type exports
├── policy/                # Policy configuration
│   └── policy.json        # Trading and withdrawal rules
├── scripts/               # Build scripts
├── test/                  # Test files
├── patches/               # Dependency patches
├── build.ts               # Build configuration
└── package.json           # Dependencies and scripts
```

### Core Components

- **CEXBroker**: Main broker class that manages exchange connections and policy enforcement
- **Policy System**: Real-time policy validation and enforcement
- **gRPC Server**: High-performance RPC interface with streaming support
- **CCXT Integration**: Unified access to 100+ cryptocurrency exchanges
- **Verity Integration**: Zero-knowledge proof generation for privacy
- **Secondary Broker Management**: Load balancing and redundancy support

## 🧪 Development

### Adding New Exchanges

The broker automatically supports all exchanges available in CCXT. To add a new exchange:

1. Add your API credentials to environment variables:
   ```env
   CEX_BROKER_<EXCHANGE>_API_KEY=your_api_key
   CEX_BROKER_<EXCHANGE>_API_SECRET=your_api_secret
   ```

2. Update policy configuration if needed for the new exchange

3. The broker will automatically detect and initialize the exchange

### Using Secondary Brokers

Secondary brokers provide redundancy and load balancing:

1. Configure secondary API keys:
   ```env
   CEX_BROKER_BINANCE_API_KEY_1=secondary_key_1
   CEX_BROKER_BINANCE_API_SECRET_1=secondary_secret_1
   ```

2. Use secondary brokers in your gRPC calls:
   ```typescript
   const metadata = new grpc.Metadata();
   metadata.set('use-secondary-key', '1'); // Use secondary broker
   ```

### Querying Supported Networks

To understand which networks each exchange supports for deposits and withdrawals, you can query the exchange's currency information:

```typescript
import ccxt from 'ccxt';

// Initialize the exchange (no API keys needed for public data)
const exchange = new ccxt.binance(); // or any other exchange like ccxt.bybit()

// Fetch all currencies and their network information
const currencies = await exchange.fetchCurrencies();

// Example: Check USDT networks on Binance
const usdtInfo = currencies['USDT'];
console.log("USDT Networks on Binance:");
console.log(usdtInfo?.networks);

// Example output:
// {
//   'BEP20': {id: 'BSC', network: 'BSC', active: true, deposit: true, withdraw: true, fee: 1.0},
//   'ETH': {id: 'ETH', network: 'ETH', active: true, deposit: true, withdraw: true, fee: 15.0},
//   'TRC20': {id: 'TRX', network: 'TRX', active: true, deposit: true, withdraw: true, fee: 1.0}
// }

// Check all available currencies
for (const [currency, info] of Object.entries(currencies)) {
  if ('networks' in info) {
    console.log(`\n${currency} networks:`);
    for (const [network, networkInfo] of Object.entries(info.networks)) {
      console.log(`  ${network}:`, networkInfo);
    }
  }
}
```

**Common Network Identifiers:**
- `BEP20` / `BSC`: Binance Smart Chain
- `ETH` / `ERC20`: Ethereum
- `TRC20`: Tron
- `ARBITRUM`: Arbitrum One
- `POLYGON`: Polygon
- `AVALANCHE`: Avalanche C-Chain
- `OPTIMISM`: Optimism

**Using this information in your policy:**

```json
{
  "withdraw": {
    "rule": {
      "networks": ["BEP20", "ARBITRUM", "ETH"],  // Networks supported by your exchanges
      "whitelist": ["0x9d467fa9062b6e9b1a46e26007ad82db116c67cb"],
      "amounts": [
        {
          "ticker": "USDT",
          "max": 100000,
          "min": 1
        }
      ]
    }
  }
}
```

### Testing

```bash
# Run all tests
bun test

# Run tests with watch mode
bun test --watch

# Run tests with coverage
bun test --coverage
```

### Code Quality

```bash
# Format code
bun run format

# Lint code
bun run lint

# Check code (format + lint)
bun run check
```

## 📦 Dependencies

### Core Dependencies

- `@grpc/grpc-js`: gRPC server implementation
- `@grpc/proto-loader`: Protocol buffer loading
- `@usherlabs/ccxt`: Enhanced CCXT library with Verity support
- `commander`: CLI framework
- `joi`: Configuration validation
- `tslog`: TypeScript logging

### Development Dependencies

- `@biomejs/biome`: Code formatting and linting
- `@types/bun`: Bun type definitions
- `bun-plugin-dts`: TypeScript declaration generation
- `bun-types`: Additional Bun types
- `husky`: Git hooks

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass (`bun test`)
6. Run code quality checks (`bun run check`)
7. Commit your changes (`git commit -m 'Add amazing feature'`)
8. Push to the branch (`git push origin feature/amazing-feature`)
9. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For issues and questions:

- Open an issue on the repository
- Contact the development team
- Check the [CCXT documentation](https://docs.ccxt.com/) for exchange-specific information

## 🙏 Acknowledgments

- [CCXT](https://github.com/ccxt/ccxt) for providing unified access to cryptocurrency exchanges
- [Bun](https://bun.sh) for the fast JavaScript runtime
- [gRPC](https://grpc.io/) for high-performance RPC communication
- [Verity](https://usher.so/) for zero-knowledge proof integration

---

**Built with ❤️ by Usher Labs**
