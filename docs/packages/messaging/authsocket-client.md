---
id: pkg-authsocket-client
title: "@bsv/authsocket-client"
kind: package
domain: messaging
version: "2.0.2"
source_repo: "bsv-blockchain/authsocket-client"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/authsocket-client"
repo: "https://github.com/bsv-blockchain/authsocket-client"
status: stable
tags: [messaging, websocket, brc-31, auth]
---

# @bsv/authsocket-client

Client-side BRC-31 authenticated WebSocket — connect to authsocket servers and prove your identity via Bitcoin signature.

## Install

```bash
npm install @bsv/authsocket-client
```

## Quick start

```typescript
import { AuthSocketClient } from '@bsv/authsocket-client';
import { WalletToolbox } from '@bsv/wallet-toolbox';

const wallet = new WalletToolbox();
const client = new AuthSocketClient({
  url: 'wss://server.example.com',
  wallet: wallet
});

// Connect and authenticate
client.on('open', () => {
  console.log('Connected and authenticated');
  client.send({ hello: 'world' });
});

// Receive messages
client.on('message', (msg) => {
  console.log('Message from server:', msg);
});

await client.connect();
```

## What it provides

- **BRC-31 authentication** — Sign connection proof with wallet key
- **WebSocket client** — Connect to BRC-31 authenticated servers
- **Wallet integration** — Use any BRC-100 wallet for signing
- **Connection events** — Listen for connect/disconnect/error/message
- **Binary support** — Send/receive binary data
- **Auto-reconnect** — Automatic reconnection with backoff
- **Timeout handling** — Configurable connection timeouts
- **Event streaming** — Standard EventEmitter interface

## When to use

- Building applications that connect to BRC-31 authenticated servers
- Creating real-time clients for game servers or chat
- Connecting to notification servers with crypto identity
- Building collaborative tools with verified user authentication
- Replacing traditional session auth with Bitcoin signatures

## When not to use

- For simple WebSocket clients without auth — use ws library
- For HTTP requests — use @bsv/auth-express-middleware
- For batch messaging — use @bsv/message-box-client instead
- For one-way communication — use fetch/HTTP instead

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/authsocket-client/)

## Related packages

- @bsv/authsocket — Server implementation
- @bsv/wallet-toolbox — Wallet for signing authentication
- @bsv/auth-express-middleware — HTTP auth middleware
- @bsv/message-box-client — Overlay-based messaging
