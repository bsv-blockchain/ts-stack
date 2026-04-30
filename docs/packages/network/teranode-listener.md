---
id: teranode-listener
title: "@bsv/teranode-listener"
kind: package
domain: network
npm: "@bsv/teranode-listener"
version: "1.0.3"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
status: stable
tags: ["network", "broadcast", "teranode", "p2p", "libp2p"]
---

# @bsv/teranode-listener

> TypeScript library for subscribing to Teranode P2P topics (blocks, subtrees, mining updates) via libp2p private DHT network.

## Install

```bash
npm install @bsv/teranode-listener
```

## Quick start

```typescript
import { TeranodeListener } from '@bsv/teranode-listener'

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

## What it provides

- **TeranodeListener** — Class-based API for subscribing to P2P topics with callbacks
- **startSubscriber** — Legacy function-based API for backward compatibility
- **Private DHT network** — Uses pre-shared key (PSK) for secure peer-to-peer communication
- **Gossipsub** — Efficient pub/sub messaging for blockchain events
- **Bootstrap peer discovery** — Connects to known peers and discovers more dynamically
- **Static peer support** — Explicitly configured peers maintained across restarts
- **Multiple topics** — Subscribe to blocks, subtrees, mining updates, handshakes, rejected transactions
- **Dynamic subscription** — Add/remove topic callbacks at runtime

## Common patterns

### Subscribe with callbacks

```typescript
const listener = new TeranodeListener({
  'bitcoin/mainnet-block': (data, topic, from) => {
    console.log('Block received:', data)
  },
  'bitcoin/mainnet-subtree': (data, topic, from) => {
    console.log('Subtree:', data)
  }
})
```

### Custom configuration

```typescript
const listener = new TeranodeListener(
  {
    'bitcoin/mainnet-block': (data, topic, from) => {
      console.log('Block:', data)
    }
  },
  {
    listenAddresses: ['/ip4/0.0.0.0/tcp/4000'],
    dhtProtocolID: '/custom-protocol',
    bootstrapPeers: ['multiaddr-of-peer-1', 'multiaddr-of-peer-2']
  }
)
```

### Dynamic topic management

```typescript
const listener = new TeranodeListener({
  'bitcoin/mainnet-block': (data, topic, from) => {
    console.log('Block:', data)
  }
})

// Add more topics later
listener.addTopicCallback('bitcoin/mainnet-subtree', (data, topic, from) => {
  console.log('Subtree:', data)
})

// Unsubscribe from a topic
listener.removeTopicCallback('bitcoin/mainnet-block')

// Access underlying libp2p node
const node = listener.getNode()

// Check connected peer count
const peerCount = listener.getConnectedPeerCount()
```

### Graceful shutdown

```typescript
const listener = new TeranodeListener(callbacks, config)

// Clean shutdown
await listener.stop()
```

## Key concepts

- **Private DHT network** — Uses pre-shared key (PSK) for closed, authenticated P2P network
- **libp2p gossipsub** — Pub/sub messaging layer for efficient blockchain event distribution
- **Topic-based subscriptions** — Subscribe to specific Teranode topics (e.g., `bitcoin/mainnet-block`)
- **Bootstrap peers** — Known peers to connect to initially; discover more peers from there
- **Static peers** — Explicitly configured peers maintained for reliable connections
- **Peer discovery** — libp2p discovers peers via bootstrap and pubsub peer discovery protocol
- **Message callbacks** — Each topic has own async callback for processing events
- **Graceful shutdown** — `.stop()` method for clean connection teardown

## Topic types

- `bitcoin/mainnet-bestblock` — Best block message
- `bitcoin/mainnet-block` — Block solution found
- `bitcoin/mainnet-subtree` — Subtree created
- `bitcoin/mainnet-mining_on` — Mining enabled
- `bitcoin/mainnet-handshake` — Peer connects
- `bitcoin/mainnet-rejected_tx` — Transaction rejected
- **Testnet variants** — Replace `mainnet` with `testnet` for testnet topics

## When to use this

- Real-time monitoring of blockchain events
- Listening for new blocks and transactions
- Monitoring mining status and peer connections
- Building blockchain applications that react to network events
- Running as part of an overlay service infrastructure

## When NOT to use this

- For transaction broadcasting — use transaction submission endpoints
- For UTXO queries — use explorer APIs or full-node RPC
- For historical blockchain data — use indexers like @bsv/overlay
- Without need for real-time updates — use batch query APIs

## Spec conformance

- **libp2p v2.9+** — Uses modern libp2p API
- **Gossipsub** — Standard pubsub protocol for message distribution
- **DHT (Kademlia)** — Distributed peer discovery
- **Noise protocol** — Modern encryption for libp2p connections
- **PSK (Pre-Shared Key)** — Private network isolation via PNET

## Common pitfalls

1. **Node.js 18+ required** — Modern async/await and crypto features
2. **ES modules only** — Package is ESM; use `.mjs` files or set `"type": "module"` in package.json
3. **Teranode mainnet defaults** — Without config, connects to official Teranode mainnet
4. **PSK hex format** — `sharedKey` must be hex-encoded; library auto-formats to PSK
5. **Static peer connection** — If unreachable, may spam logs; consider retry logic
6. **Message data format** — Teranode messages are raw `Uint8Array`; caller must deserialize (typically BSV transaction/block)
7. **Blocking callbacks** — Slow callbacks queue messages; consider async processing
8. **Network requirements** — Requires TCP connectivity on configured listen ports

## Related packages

- [@bsv/overlay](../overlays/overlay.md) — Can use TeranodeListener for transaction submission
- [@bsv/sdk](https://github.com/bsv-blockchain/ts-sdk) — Transaction and block deserialization
- [@bsv/overlay-express](../overlays/overlay-express.md) — Overlay services can integrate with network

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/ts-p2p/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-p2p)
- [npm](https://www.npmjs.com/package/@bsv/teranode-listener)
- [libp2p documentation](https://docs.libp2p.io/)
