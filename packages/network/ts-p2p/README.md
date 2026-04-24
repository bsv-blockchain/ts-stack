# @bsv/teranode-listener

BSV BLOCKCHAIN | A TypeScript library for subscribing to Teranode P2P topics in a private DHT network

A robust npm package that enables subscription to Teranode P2P topics using libp2p with private network support, DHT, and gossipsub messaging.

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Getting Started](#getting-started)
4. [API Reference](#api-reference)
5. [Configuration](#configuration)
6. [Examples](#examples)
7. [Development](#development)
8. [Contributing](#contributing)
9. [Support & Contacts](#support--contacts)

## Overview

The `@bsv/teranode-listener` package provides a simple yet powerful interface for connecting to Teranode's private P2P network. It handles:

- **Private Network Access**: Secure connections using pre-shared keys (PSK)
- **DHT Integration**: Distributed hash table for peer discovery
- **Topic Subscription**: Subscribe to specific topics and receive real-time messages
- **Peer Management**: Automatic peer discovery and connection management
- **Message Logging**: Built-in logging for network events and messages

## Installation

```bash
npm install @bsv/teranode-listener
```

### Requirements

- **Node.js**: Version 18.0.0 or higher
- **ES Modules**: This package is published as an ES module. Ensure your project supports ES modules by either:
  - Adding `"type": "module"` to your `package.json`, or
  - Using `.mjs` file extensions for your JavaScript files

## Getting Started

### Callback-Based API (Recommended)

The easiest way to use the library is with the `TeranodeListener` class, which provides topic-specific callbacks:

```typescript
import { TeranodeListener } from '@bsv/teranode-listener';

// Define callback functions for different topics
const blockCallback = (data: Uint8Array, topic: string, from: string) => {
  console.log(`New block received from ${from}:`, data);
  // Process block data here
};

const subtreeCallback = (data: Uint8Array, topic: string, from: string) => {
  console.log(`Subtree update from ${from}:`, data);
  // Process subtree data here
};

// Create listener with topic callbacks
const listener = new TeranodeListener({
  'bitcoin/mainnet-block': blockCallback,
  'bitcoin/mainnet-subtree': subtreeCallback
});

// The listener starts automatically and connects to Teranode mainnet
console.log('Listener started and waiting for messages...');
```

### Function-Based API

Alternatively, you can use the original function-based API:

```typescript
import { startSubscriber } from '@bsv/teranode-listener';

// Start with default configuration (connects to Teranode mainnet)
const { node, stop } = await startSubscriber({
  onMessage: (data, topic, from) => {
    console.log(`Message on ${topic} from ${from}:`, data);
  }
});

console.log('Subscriber started and listening for messages...');
```

Both approaches automatically:
- Connect to the official Teranode bootstrap peer
- Use the mainnet shared key
- Listen on `127.0.0.1:9901`
- Connect to known active Teranode peers

### Custom Configuration

```typescript
import { startSubscriber } from '@bsv/teranode-listener';

const config = {
  topics: ['teranode/blocks'], // Only subscribe to blocks
  listenAddresses: ['/ip4/0.0.0.0/tcp/4000'] // Listen on a different port
};

// Start with custom topics and port
await startSubscriber(config);
console.log('Subscriber started with custom configuration...');
```

### Complete Custom Setup

```typescript
import { startSubscriber } from '@bsv/teranode-listener';

const config = {
  bootstrapPeers: [
    '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWExample1'
  ],
  staticPeers: [
    '/ip4/192.168.1.100/tcp/4003/p2p/12D3KooWStatic1',
    '/ip4/192.168.1.101/tcp/4003/p2p/12D3KooWStatic2'
  ],
  sharedKey: 'your-custom-hex-shared-key-here',
  topics: ['custom/topic'],
  listenAddresses: ['/ip4/0.0.0.0/tcp/4000'],
  dhtProtocolID: '/custom-protocol'
};

await startSubscriber(config);
```

For more detailed examples, check our [Examples](#examples) section.

## API Reference

### `TeranodeListener` Class (Recommended)

The primary API for subscribing to Teranode P2P topics with callback functions.

#### Constructor

```typescript
new TeranodeListener(topicCallbacks: TopicCallbacks, config?: TeranodeListenerConfig)
```

**Parameters:**
- `topicCallbacks` - Object mapping topic names to callback functions
- `config` - Optional configuration (uses Teranode mainnet defaults)

**Example:**
```typescript
const listener = new TeranodeListener({
  'bitcoin/mainnet-block': (data, topic, from) => {
    console.log('Block received:', data);
  },
  'bitcoin/mainnet-subtree': (data, topic, from) => {
    console.log('Subtree update:', data);
  }
});
```

#### Methods

- `addTopicCallback(topic: Topic, callback: MessageCallback): void` - Add a new topic subscription
- `removeTopicCallback(topic: Topic): void` - Remove a topic subscription
- `stop(): Promise<void>` - Stop the listener
- `getNode(): Libp2p | null` - Get the underlying libp2p node
- `getConnectedPeerCount(): number` - Get number of connected peers

#### Types

```typescript
// Supported Teranode P2P topics
export type Topic = 
  'bitcoin/mainnet-bestblock' |    // Best block message
  'bitcoin/mainnet-block' |        // When miners find a block solution
  'bitcoin/mainnet-subtree' |      // When a subtree is created
  'bitcoin/mainnet-mining_on' |    // When mining is enabled
  'bitcoin/mainnet-handshake' |    // When a peer connects to the network
  'bitcoin/mainnet-rejected_tx';   // When a transaction is rejected

type MessageCallback = (data: Uint8Array, topic: Topic, from: string) => void;
type TopicCallbacks = Partial<Record<Topic, MessageCallback>>;

interface TeranodeListenerConfig {
  bootstrapPeers?: string[];       // Bootstrap peer multiaddrs (default: Teranode mainnet bootstrap)
  staticPeers?: string[];          // Static peer multiaddrs (default: Known Teranode mainnet peers)
  sharedKey?: string;              // Hex string of PSK (default: Teranode mainnet key)
  dhtProtocolID?: string;          // DHT protocol prefix (default: '/teranode')
  listenAddresses?: string[];      // Listen addresses (default: ['/ip4/127.0.0.1/tcp/9901'])
  usePrivateDHT?: boolean;         // Whether to use private DHT (default: true)
}
```

### `startSubscriber(config?: SubscriberConfig): Promise<void>`

Legacy function-based API for subscribing to topics.

#### Parameters

- `config` - Optional configuration object for the subscriber. If not provided, uses mainnet defaults.

#### Returns

A Promise that resolves when the subscriber is successfully started.

### `SubscriberConfig`

Configuration interface for the function-based API. All parameters are optional:

```typescript
interface SubscriberConfig {
  bootstrapPeers?: string[];       // Bootstrap peer multiaddrs (default: Teranode mainnet bootstrap)
  staticPeers?: string[];          // Static peer multiaddrs (default: Known Teranode mainnet peers)
  sharedKey?: string;              // Hex string of PSK (default: Teranode mainnet key)
  dhtProtocolID?: string;          // DHT protocol prefix (default: '/teranode')
  topics?: Topic[];                // Topics to subscribe to (default: all Teranode topics)
  listenAddresses?: string[];      // Listen addresses (default: ['/ip4/127.0.0.1/tcp/9901'])
  usePrivateDHT?: boolean;         // Whether to use private DHT (default: true)
}
```

## Configuration

### Default Configuration

The package comes with production-ready defaults for Teranode mainnet:

- **`bootstrapPeers`**: `['/dns4/teranode-bootstrap.bsvb.tech/tcp/9901/p2p/12D3KooWESmhNAN8s6NPdGNvJH3zJ4wMKDxapXKNUe2DzkAwKYqK']`
- **`staticPeers`**: Array of known active Teranode mainnet peers (TAAL, BSVB, etc.)
- **`sharedKey`**: Teranode mainnet pre-shared key
- **`topics`**: `['teranode/blocks', 'teranode/transactions']`
- **`listenAddresses`**: `['/ip4/127.0.0.1/tcp/9901']`
- **`dhtProtocolID`**: `/teranode`
- **`usePrivateDHT`**: `true`

### Customizable Parameters

All parameters are optional and can be overridden:

- **`bootstrapPeers`**: Array of multiaddr strings for initial peer discovery
- **`staticPeers`**: Additional peers to maintain persistent connections with
- **`sharedKey`**: Hexadecimal string representing the pre-shared key for network access
- **`topics`**: Array of topic strings to subscribe to
- **`listenAddresses`**: Network addresses to listen on
- **`dhtProtocolID`**: Custom DHT protocol identifier
- **`usePrivateDHT`**: Whether to use private DHT networking

### Pre-Shared Key Format

The `sharedKey` should be provided as a hexadecimal string without the PSK headers. The library automatically formats it as:

```
/key/swarm/psk/1.0.0/
/base16/
<your-hex-key>
```

## Examples

### Example 1: Basic TeranodeListener Usage

```typescript
import { TeranodeListener, type Topic } from '@bsv/teranode-listener';

// Simple callback-based listener
const listener = new TeranodeListener({
  'bitcoin/mainnet-block': (data: Uint8Array, topic: Topic, from: string) => {
    console.log(`New block from ${from}:`, data.length, 'bytes');
    // Process block data
  },
  'bitcoin/mainnet-subtree': (data: Uint8Array, topic: Topic, from: string) => {
    console.log(`Subtree update from ${from}:`, data.length, 'bytes');
    // Process subtree data
  }
});

console.log('Listener started, waiting for messages...');
```

### Example 2: Advanced TeranodeListener with Custom Configuration

```typescript
import { TeranodeListener } from '@bsv/teranode-listener';

// Create a listener with topic-specific callbacks
const listener = new TeranodeListener({
  'bitcoin/mainnet-block': (data, topic, from) => {
    console.log(`Received block from ${from}:`, data);
  },
  'bitcoin/mainnet-subtree': (data, topic, from) => {
    console.log(`Received subtree from ${from}:`, data);
  }
});

// The listener starts automatically
console.log('Connected peers:', listener.getConnectedPeerCount());

// Add more topics dynamically
listener.addTopicCallback('bitcoin/mainnet-transaction', (data, topic, from) => {
  console.log(`Received transaction from ${from}:`, data);
});

// Monitor connection status
setInterval(() => {
  console.log('Connected peers:', listener.getConnectedPeerCount());
}, 30000);
```

### Example 3: Function-Based API (Legacy)

```typescript
import { startSubscriber } from '@bsv/teranode-listener';

// Connect to Teranode mainnet with all defaults
startSubscriber()
  .then(() => console.log('Connected to Teranode mainnet!'))
  .catch(console.error);
```

### Example 4: Custom Port and Multiple Topics (Function API)

```typescript
import { startSubscriber } from '@bsv/teranode-listener';

// Use a different port and subscribe to multiple topics
const config = {
  topics: [
    'teranode/blocks',
    'teranode/transactions',
    'teranode/mempool'
  ],
  listenAddresses: ['/ip4/0.0.0.0/tcp/4000']
};

await startSubscriber(config);
console.log('Listening on port 4000 for blocks, transactions, and mempool...');
```

### Example 5: Environment-Based Configuration

```typescript
import { startSubscriber } from '@bsv/teranode-listener';

const config = {
  topics: process.env.TOPICS?.split(',') || undefined, // Use defaults if not set
  listenAddresses: process.env.LISTEN_ADDRESS ? [process.env.LISTEN_ADDRESS] : undefined,
  sharedKey: process.env.CUSTOM_SHARED_KEY || undefined // Use default mainnet key if not set
};

// Start with environment overrides, falling back to defaults
await startSubscriber(config);
console.log('Started with environment configuration...');
```

### Example 6: Complete Custom Network

```typescript
import { startSubscriber } from '@bsv/teranode-listener';

// Connect to a custom private network
const config = {
  bootstrapPeers: [
    '/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWBootstrap1',
    '/ip4/10.0.0.2/tcp/4001/p2p/12D3KooWBootstrap2'
  ],
  staticPeers: [
    '/ip4/10.0.0.10/tcp/4003/p2p/12D3KooWStatic1'
  ],
  sharedKey: 'your-custom-private-network-key',
  dhtProtocolID: '/custom-network',
  topics: ['custom/blocks', 'custom/transactions'],
  listenAddresses: ['/ip4/0.0.0.0/tcp/4000'],
  usePrivateDHT: true
};

await startSubscriber(config);
console.log('Connected to custom private network...');
```

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/bitcoin-sv/ts-p2p.git
cd ts-p2p

# Install dependencies
npm install

# Build the project
npm run build
```

### Project Structure

```
ts-p2p/
├── src/
│   └── index.ts          # Main library code
├── dist/                 # Compiled JavaScript output
├── package.json          # Package configuration
├── tsconfig.json         # TypeScript configuration
└── README.md            # This file
```

### Dependencies

This package relies on several key libp2p modules:

- **libp2p**: Core P2P networking library
- **@chainsafe/libp2p-gossipsub**: Gossip-based pub/sub messaging
- **@libp2p/kad-dht**: Kademlia DHT for peer discovery
- **@libp2p/pnet**: Private network support with PSK
- **@chainsafe/libp2p-noise**: Noise protocol for secure connections

## Contributing

We welcome contributions to improve the `@bsv/teranode-listener` package. Whether it's bug reports, feature requests, or pull requests - all contributions are appreciated.

### How to Contribute

1. **Fork the repository** - Start by forking the project repository to your GitHub account
2. **Clone the repository** - Clone the forked repository to your local machine
3. **Create a new branch** - Create a new branch for your feature or bug fix
4. **Make your changes** - Implement your changes with appropriate tests
5. **Build and test** - Ensure the project builds and all tests pass
6. **Submit a pull request** - Submit a pull request with a clear description

### Development Guidelines

- Follow TypeScript best practices
- Maintain backward compatibility when possible
- Add tests for new features
- Update documentation as needed
- Follow the existing code style and conventions

## Support & Contacts

Project Maintainers:

- [BSV Blockchain](https://github.com/bitcoin-sv)

For questions, bug reports, or feature requests:

- [Open an issue](https://github.com/bitcoin-sv/ts-p2p/issues) on GitHub
- Check existing [documentation](https://docs.bsvblockchain.org/)

---

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

Thank you for being a part of the BSV Blockchain ecosystem. Let's build the future of BSV Blockchain together!
