---
id: teranode-listener
title: "@bsv/teranode-listener"
kind: package
domain: network
npm: "@bsv/teranode-listener"
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["network", "broadcast", "teranode"]
---

# @bsv/teranode-listener

Connect to Teranode and broadcast transactions, query UTXOs, and listen for updates.

## Features

- Broadcast signed transactions
- Query UTXO set
- Listen for new transactions
- Full-node compatibility

## Installation

```bash
npm install @bsv/teranode-listener
```

## Quick Start

```typescript
import { TeranodeListener } from '@bsv/teranode-listener';

const listener = new TeranodeListener('https://teranode.example.com');

// Broadcast a transaction
const result = await listener.broadcast(signedTx);

// Query UTXOs
const utxos = await listener.getUtxos(address);
```
