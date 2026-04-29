---
id: pkg-authsocket
title: "@bsv/authsocket"
kind: package
domain: messaging
version: "2.0.1"
source_repo: "bsv-blockchain/authsocket"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/authsocket"
repo: "https://github.com/bsv-blockchain/authsocket"
status: stable
tags: [messaging, websocket, brc-31, auth]
---

# @bsv/authsocket

Server-side BRC-31 authenticated WebSocket — accept real-time connections from clients who prove their identity via Bitcoin signature.

## Install

```bash
npm install @bsv/authsocket
```

## Quick start

```typescript
import { AuthSocket } from '@bsv/authsocket';
import express from 'express';
import http from 'http';

const app = express();
const server = http.createServer(app);
const authSocket = new AuthSocket(server);

// Accept authenticated connections
authSocket.on('connection', (socket, identity) => {
  console.log('User connected:', identity.publicKey);
  
  socket.on('message', (msg) => {
    console.log('Message from', identity.publicKey, ':', msg);
  });
});

server.listen(3000);
```

## What it provides

- **BRC-31 authentication** — Verify connections with Bitcoin signatures
- **WebSocket upgrade** — Secure WebSocket connections with crypto identity
- **Connection events** — Listen for connect/disconnect/message events
- **Identity verification** — Access verified public key and identity
- **Binary support** — Send/receive binary data over WebSocket
- **Automatic reconnection** — Built-in reconnect logic with exponential backoff
- **Rate limiting** — Configurable per-connection message rate limits
- **Middleware hooks** — Extensible authentication pipeline

## When to use

- Building real-time applications that need cryptographic identity
- Creating chat or notification systems with verified users
- Implementing game servers with signature-based authentication
- Building collaborative tools where users prove their identity
- Replacing traditional JWT/session auth with Bitcoin signatures

## When not to use

- For simple WebSocket communication without auth — use ws library
- If you need certificate-based TLS auth — use server TLS instead
- For REST APIs — use @bsv/auth-express-middleware
- For one-way broadcasts — use Server-Sent Events instead

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/authsocket/)

## Related packages

- @bsv/authsocket-client — Client library for connecting
- @bsv/auth-express-middleware — Express middleware for HTTP requests
- @bsv/sdk — Signature verification primitives
- @bsv/wallet-toolbox — Wallet for client authentication
