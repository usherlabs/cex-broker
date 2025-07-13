# CEX Broker

A high-performance gRPC-based cryptocurrency exchange broker service that provides unified access to multiple centralized exchanges (CEX) through the CCXT library. Built with TypeScript, Bun, and designed for reliable trading operations with policy enforcement.

## 🚀 Features

- **Multi-Exchange Support**: Unified API to any CEX supported by [CCXT](https://github.com/ccxt/ccxt) (100+ exchanges)
- **gRPC Interface**: High-performance RPC communication with type safety
- **Policy Enforcement**: Configurable trading and withdrawal limits with real-time policy updates
- **IP Authentication**: Security through IP whitelisting
- **Real-time Policy Updates**: Hot-reload policy changes without server restart
- **Type Safety**: Full TypeScript support with generated protobuf types
- **Comprehensive Logging**: Built-in logging with tslog
- **CLI Support**: Command-line interface for easy management

## 📋 Prerequisites

- [Bun](https://bun.sh) (v1.2.17 or higher)
- API keys for supported exchanges (e.g., Binance, Bybit, etc.)

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

# Exchange API Keys (format: CEX_BROKER_<EXCHANGE>_API_KEY/SECRET)
CEX_BROKER_BINANCE_API_KEY=your_binance_api_key
CEX_BROKER_BINANCE_API_SECRET=your_binance_api_secret
CEX_BROKER_BYBIT_API_KEY=your_bybit_api_key
CEX_BROKER_BYBIT_API_SECRET=your_bybit_api_secret
CEX_BROKER_KRAKEN_API_KEY=your_kraken_api_key
CEX_BROKER_KRAKEN_API_SECRET=your_kraken_api_secret
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
# Development mode
bun run start

# Production build
bun run build:ts
bun run ./build/index.js
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

The service exposes a gRPC interface with the following method:

### ExecuteCcxtAction

Execute any CCXT method on supported exchanges.

**Request:**
```protobuf
message CcxtActionRequest {
  Action action = 1;                        // The CCXT method to call
  map<string, string> payload = 2;          // Parameters to pass to the CCXT method
  string cex = 3;                           // CEX identifier (e.g., "binance", "bybit")
  string symbol = 4;                        // Optional: trading pair symbol if needed
}
```

**Response:**
```protobuf
message CcxtActionResponse {
  string result = 2;                        // JSON string of the result data
}
```

**Available Actions:**
- `NoAction` (0): No operation
- `Deposit` (1): Deposit funds
- `Transfer` (2): Transfer/withdraw funds
- `CreateOrder` (3): Create a new order
- `GetOrderDetails` (4): Get order information
- `CancelOrder` (5): Cancel an existing order
- `FetchBalance` (6): Get account balance

**Example Usage:**

```typescript
// Fetch balance
const balanceRequest = {
  action: 6, // FetchBalance
  payload: {},
  cex: "binance",
  symbol: ""
};

// Create order
const orderRequest = {
  action: 3, // CreateOrder
  payload: {
    symbol: "BTC/USDT",
    type: "limit",
    side: "buy",
    amount: "0.001",
    price: "50000"
  },
  cex: "binance",
  symbol: "BTC/USDT"
};
```

## 🔒 Security

### IP Authentication

All API calls require IP authentication. Configure allowed IPs in the broker initialization:

```typescript
const config = {
  port: 8086,
  whitelistIps: [
    "127.0.0.1", // localhost
    "::1",       // IPv6 localhost
    "192.168.1.100", // Your allowed IP
  ]
};
```

### API Key Management

- Store API keys securely in environment variables
- Use read-only API keys when possible
- Regularly rotate API keys
- Monitor API usage and set appropriate rate limits

## 🏗️ Architecture

### Project Structure

```
fietCexBroker/
├── src/                    # Source code
│   ├── commands/          # CLI commands
│   ├── helpers/           # Utility functions
│   ├── index.ts           # Main broker class
│   ├── server.ts          # gRPC server implementation
│   └── cli.ts             # CLI entry point
├── proto/                 # Protocol buffer definitions
│   ├── node.proto         # Service definition
│   └── node.ts            # Type exports
├── policy/                # Policy configuration
│   └── policy.json        # Trading and withdrawal rules
├── scripts/               # Build scripts
├── test/                  # Test files
├── types.ts               # TypeScript type definitions
├── build.ts               # Build configuration
└── package.json           # Dependencies and scripts
```

### Core Components

- **CEXBroker**: Main broker class that manages exchange connections and policy enforcement
- **Policy System**: Real-time policy validation and enforcement
- **gRPC Server**: High-performance RPC interface
- **CCXT Integration**: Unified access to 100+ cryptocurrency exchanges

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
- `ccxt`: Cryptocurrency exchange library (100+ exchanges)
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

---

**Built with ❤️ by Usher Labs**
