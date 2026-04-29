# CLAUDE.md — @bsv/teranode-listener

## Purpose
TypeScript library for subscribing to Teranode P2P topics (blocks, subtrees, mining updates, etc.) via libp2p private DHT network. Enables applications to listen to Bitcoin SV blockchain events in real-time from a Teranode peer.

## Public API surface

### TeranodeListener (Class — Recommended)
- **Constructor**: `new TeranodeListener(topicCallbacks, config?)`
  - `topicCallbacks: Partial<Record<Topic, MessageCallback>>` — object mapping topic names to callbacks
  - `config?: TeranodeListenerConfig` — optional connection config (uses mainnet defaults if omitted)
  - Auto-starts immediately on construction
  
- **Methods**:
  - `async start()` — start listener and connect to Teranode peers
  - `async stop()` — cleanly shutdown listener
  - `addTopicCallback(topic, callback)` — dynamically add/subscribe to a topic
  - `removeTopicCallback(topic)` — unsubscribe from a topic
  - `getNode()` — get underlying libp2p `Libp2p` instance
  - `getConnectedPeerCount()` — return number of connected peers

### startSubscriber (Function — Legacy API)
- **Function**: `async startSubscriber(config?: SubscriberConfig)`
  - Options: `bootstrapPeers`, `staticPeers`, `sharedKey`, `dhtProtocolID`, `topics`, `listenAddresses`, `usePrivateDHT`
  - Returns `Promise<void>` — listener runs in background; call process termination to stop

## Real usage patterns

From README (TeranodeListener — recommended):
```ts
import { TeranodeListener } from '@bsv/teranode-listener'

// Define callbacks for topics
const blockCallback = (data: Uint8Array, topic: string, from: string) => {
  console.log(`New block from ${from}:`, data)
}

const subtreeCallback = (data: Uint8Array, topic: string, from: string) => {
  console.log(`Subtree update from ${from}:`, data)
}

// Create listener with callbacks
const listener = new TeranodeListener({
  'bitcoin/mainnet-block': blockCallback,
  'bitcoin/mainnet-subtree': subtreeCallback
})

console.log('Listener started, waiting for messages...')
```

Function-based API (legacy):
```ts
import { startSubscriber } from '@bsv/teranode-listener'

// Start with default config (mainnet)
const { node, stop } = await startSubscriber({
  onMessage: (data, topic, from) => {
    console.log(`Message on ${topic} from ${from}:`, data)
  }
})

console.log('Subscriber started...')
```

Custom configuration:
```ts
const listener = new TeranodeListener(
  {
    'teranode/blocks': (data, topic, from) => {
      console.log('Block received:', data)
    }
  },
  {
    topics: ['teranode/blocks'],
    listenAddresses: ['/ip4/0.0.0.0/tcp/4000'],
    dhtProtocolID: '/custom-protocol'
  }
)
```

Dynamic topic subscription:
```ts
const listener = new TeranodeListener({
  'bitcoin/mainnet-block': (data, topic, from) => {
    console.log('Block:', data)
  }
})

// Later, add more topics
listener.addTopicCallback('bitcoin/mainnet-subtree', (data, topic, from) => {
  console.log('Subtree:', data)
})

// Unsubscribe from a topic
listener.removeTopicCallback('bitcoin/mainnet-block')
```

## Key concepts

- **Private DHT network**: Teranode uses a pre-shared key (PSK) to create a private, closed P2P network
- **libp2p gossipsub**: Pub/sub messaging layer for distributing blockchain events
- **Topic-based subscriptions**: Subscribe to specific Teranode topics (e.g., 'bitcoin/mainnet-block')
- **Bootstrap peers**: Known peers to connect to initially; discover more peers from there
- **Static peers**: Explicitly configured peers to maintain connections to
- **Peer discovery**: libp2p discovers peers via bootstrap and pubsub peer discovery protocol
- **Message callbacks**: Each topic can have its own callback for async message handling
- **Graceful shutdown**: Call `.stop()` or catch SIGINT for clean connection teardown

## Topic Types

- `bitcoin/mainnet-bestblock` — Best block message
- `bitcoin/mainnet-block` — Block solution found
- `bitcoin/mainnet-subtree` — Subtree created
- `bitcoin/mainnet-mining_on` — Mining enabled
- `bitcoin/mainnet-handshake` — Peer connects
- `bitcoin/mainnet-rejected_tx` — Transaction rejected
- Similar topics exist for testnet: `bitcoin/testnet-*`

## Dependencies

- `@bsv/sdk` ^2.0.14 — SDK utilities
- `libp2p` ^2.9.0 — Base P2P networking library
- `@libp2p/tcp` ^10.1.18 — TCP transport
- `@chainsafe/libp2p-noise` ^16.1.4 — Encryption
- `@chainsafe/libp2p-yamux` ^7.0.4 — Stream multiplexing
- `@libp2p/kad-dht` ^15.1.10 — DHT protocol
- `@chainsafe/libp2p-gossipsub` ^14.1.1 — Gossip pub/sub
- `@libp2p/bootstrap` ^11.0.46 — Bootstrap peer discovery
- `@libp2p/pnet` ^2.0.42 — Private network support
- `@libp2p/pubsub-peer-discovery` ^11.0.0 — Pubsub-based peer discovery
- Dev: TypeScript, ts-node

## Common pitfalls / gotchas

1. **Node.js 18+ required** — Modern async/await and crypto features needed
2. **ES modules only** — Package is published as ESM; use `.mjs` files or set `"type": "module"` in package.json
3. **Teranode mainnet defaults** — If no config provided, connects to official Teranode mainnet; ensure correct `sharedKey` for private networks
4. **PSK hex format** — `sharedKey` must be hex-encoded; library auto-formats to PSK protocol
5. **Static peer connection** — If static peers are provided, library maintains reconnection; may spam logs if peers are unreachable
6. **Message data format** — Teranode messages are raw `Uint8Array`; caller must deserialize (typically BSV transaction or block data)
7. **No auto-reconnect between topics** — Once listener is started, adding/removing topics doesn't require restart
8. **Blocking callbacks** — If message callback is slow, other messages may queue; consider async processing

## Spec conformance

- **libp2p v2.9+** — Uses modern libp2p API
- **Gossipsub** — Standard pubsub protocol for message distribution
- **DHT (Kademlia)** — Distributed peer discovery
- **Noise protocol** — Modern encryption for libp2p connections
- **PSK (Pre-Shared Key)** — Private network isolation

## File map

```
/Users/personal/git/ts-stack/packages/network/ts-p2p/
  src/
    index.ts              — exports TeranodeListener, startSubscriber
  README.md               — documentation with examples
  package.json            — dependencies (libp2p, gossipsub, etc.)
  tsconfig.json          — TypeScript config
```

## Integration points

- **@bsv/sdk** — Utilities and types
- **libp2p ecosystem** — All peer-to-peer networking via libp2p plugins
- **Teranode infrastructure** — Connects to official Teranode bootstrap and static peers
- No direct integration with other ts-stack packages; operates independently
