---
id: pkg-gasp
title: "@bsv/gasp"
kind: package
domain: overlays
version: "1.2.2"
source_repo: "bsv-blockchain/gasp"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/gasp"
repo: "https://github.com/bsv-blockchain/gasp"
status: stable
tags: [overlay, sync, gasp, graph]
---

# @bsv/gasp

GASP (Graph Aware Sync Protocol) core — synchronize transaction graphs between overlay nodes efficiently and reliably.

## Install

```bash
npm install @bsv/gasp
```

## Quick start

```typescript
import { GASP, GASPNode } from '@bsv/gasp';

// Create a GASP node
const node = new GASPNode({
  nodeId: 'node-1',
  storage: mongoStorage // your storage backend
});

// Register graph handlers
node.on('graph', async (graph) => {
  console.log('Received transaction graph:', graph.transactionIds);
  // Process the graph...
});

// Sync with peers
await node.syncWith(['peer-node-1', 'peer-node-2']);
```

## What it provides

- **Graph synchronization** — Efficiently sync sets of related transactions
- **Merkle tree based** — Minimize data transfer with Merkle tree comparisons
- **Conflict resolution** — Handle divergent chains and reorganizations
- **Partial sync** — Request only missing transactions
- **Batch operations** — Process multiple graphs atomically
- **Peer discovery** — Connect to and sync with other GASP nodes
- **Storage abstraction** — Plug in any backend (MongoDB, PostgreSQL, LevelDB)
- **Event streaming** — Receive graphs as they arrive from peers

## When to use

- Synchronizing transaction state between overlay nodes
- Building decentralized applications that need consistent graph state
- Implementing overlay consensus mechanisms
- Creating sharded or federated overlay networks
- Optimizing bandwidth when syncing large transaction sets

## When not to use

- For simple message passing — use @bsv/message-box-client
- If you only need transaction broadcast — use @bsv/teranode-listener
- For SPV proof verification — use @bsv/sdk directly
- For non-transaction data — use generic sync protocols

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/gasp/)

## Related packages

- @bsv/overlay — Overlay infrastructure that uses GASP for sync
- @bsv/overlay-express — HTTP server for GASP nodes
- @bsv/sdk — Transaction creation and verification
- @bsv/teranode-listener — Network communication
