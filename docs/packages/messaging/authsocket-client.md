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

> Client-side BRC-103 mutual authentication wrapper for socket.io-client. Signs all outbound messages and verifies inbound messages using a wallet, enabling authenticated peer-to-peer WebSocket communication.

## Install

```bash
npm install @bsv/authsocket-client
```

## Quick start

```typescript
import { AuthSocketClient } from '@bsv/authsocket-client'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'

const clientWallet = new ProtoWallet(PrivateKey.fromHex('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'))
const socket = AuthSocketClient('http://localhost:3000', { wallet: clientWallet })

socket.on('connect', () => {
  console.log('Connected. Socket ID:', socket.id)
  socket.emit('chatMessage', { text: 'Hello from client!' })
})

socket.on('chatMessage', (msg) => {
  console.log('Server says:', msg)
})

socket.on('disconnect', () => {
  console.log('Disconnected')
})
```

## What it provides

- **AuthSocketClient** — Wraps socket.io-client with BRC-103 authentication
- **Automatic message signing** — All outbound messages signed with client wallet key
- **Automatic message verification** — Inbound messages verified against server's public key
- **BRC-103 handshake** — Nonce-based challenge-response protocol
- **Transparent proxying** — User code sees normal Socket.IO API; BRC-103 hidden
- **Certificate exchange** — Supports verifiable certificates during handshake (optional)
- **Standard Socket.IO interface** — `.on()`, `.emit()`, `.id`, `.connect()`, `.disconnect()`

## Common patterns

### Basic authenticated connection

```typescript
import { AuthSocketClient } from '@bsv/authsocket-client'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'

const wallet = new ProtoWallet(PrivateKey.fromHex('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'))
const socket = AuthSocketClient('http://localhost:3000', { wallet })

socket.on('connect', () => {
  console.log('Authenticated')
  socket.emit('joinRoom', 'general')
})

socket.on('message', (data) => {
  console.log('Received:', data)
})
```

### With custom manager options

```typescript
const socket = AuthSocketClient('http://localhost:3000', {
  wallet: myWallet,
  managerOptions: {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5
  }
})
```

## Key concepts

- **BRC-103 mutual authentication** — Nonce-based challenge-response protocol
- **Ephemeral nonces** — Each outbound message includes fresh nonce + signature
- **Signature verification** — Inbound messages verified against server's public key
- **Session binding** — Server nonce proves server identity; client nonce proves client identity
- **Certificate exchange** — Optional verifiable certificates during handshake
- **Transparent proxying** — User code interacts with normal Socket.IO API

## When to use this

- Connecting to BRC-103 authenticated servers (e.g., `@bsv/authsocket`)
- Real-time applications requiring cryptographic identity
- Building collaborative tools with verified user authentication
- Live messaging systems with signature-based security
- Games or interactive apps needing peer identity verification

## When NOT to use this

- Simple WebSocket clients without authentication — use Socket.IO directly
- REST APIs with request/response auth — use `@bsv/auth-express-middleware`
- Batch or store-and-forward messaging — use `@bsv/message-box-client` instead
- One-way data feeds — Server-Sent Events may be simpler

## Spec conformance

- **BRC-103** (Peer-to-Peer Mutual Authentication): Full handshake, nonce exchange, signature verification, optional certificate exchange
- Uses BRC-103 `Peer` and `Transport` abstractions from SDK
- Client transport implements ephemeral nonce generation + signing

## Common pitfalls

1. **Wallet must be BRC-100 compatible** — needs `sign()` and `verify()` methods
2. **Server must support BRC-103** — use `@bsv/authsocket` or implement BRC-103 `Peer` yourself
3. **Nonce tracking handled automatically** — library auto-generates nonces; don't manually set them
4. **Signature verification automatic** — inbound messages verified; if verification fails, message is dropped
5. **Handshake must complete first** — BRC-103 handshake completes before general messages; library handles this

## Related packages

- **@bsv/authsocket** — Server-side counterpart; host authenticated WebSocket server
- **@bsv/message-box-client** — Uses `AuthSocketClient` for live message delivery
- **@bsv/auth-express-middleware** — HTTP authentication for REST endpoints

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/authsocket-client/)
- [Source on GitHub](https://github.com/bsv-blockchain/authsocket-client)
- [npm](https://www.npmjs.com/package/@bsv/authsocket-client)
