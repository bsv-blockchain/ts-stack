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

> Server-side BRC-103 mutual authentication wrapper for Socket.IO. Enforces cryptographic signing and verification on all WebSocket messages, enabling peer-to-peer identity verification and certificate exchange.

## Install

```bash
npm install @bsv/authsocket
```

## Quick start

```typescript
import { AuthSocketServer } from '@bsv/authsocket'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import http from 'http'

const server = http.createServer()
const serverWallet = new ProtoWallet(PrivateKey.fromHex('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'))
const io = new AuthSocketServer(server, { wallet: serverWallet, cors: { origin: '*' } })

io.on('connection', async (socket) => {
  console.log('Authenticated socket:', socket.id)

  socket.on('chatMessage', (msg) => {
    console.log('Verified message:', msg)
  })

  await socket.emit('chatMessage', { from: socket.id, text: 'Hello client' })
})

server.listen(3000)
```

## What it provides

- **AuthSocketServer** — Wraps HTTP server to add BRC-103 authentication to Socket.IO
- **AuthSocket** — Socket wrapper with auto-signing and verification on all messages
- **BRC-103 handshake** — Nonce-based challenge-response mutual authentication
- **Session management** — Tracks nonces and authentication state per socket
- **Certificate exchange** — Support for requesting and verifying certificates during handshake
- **Message signing** — Every message auto-signed with server wallet; every inbound message verified
- **Automatic re-dispatch** — Special `'authMessage'` channel for BRC-103 frames; user code sees normal Socket.IO events

## Common patterns

### Server setup with certificate requests

```typescript
import { AuthSocketServer } from '@bsv/authsocket'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'

const wallet = new ProtoWallet(PrivateKey.fromHex(privateKeyHex))
const io = new AuthSocketServer(server, {
  wallet,
  cors: { origin: '*' },
  requestedCertificates: {
    certifiers: ['<33-byte-pubkey-hex>'],
    types: {
      'age-verification': ['dateOfBirth', 'country']
    }
  }
})

io.on('connection', async (socket) => {
  socket.on('message', (data) => {
    // All messages already verified
  })
  await socket.emit('response', { authenticated: true })
})
```

### Receiving authenticated messages

```typescript
io.on('connection', async (socket) => {
  // Messages are automatically verified before reaching here
  socket.on('userAction', (action) => {
    console.log('Verified action from', socket.id, ':', action)
  })

  // Send authenticated response
  await socket.emit('status', { result: 'success' })
})
```

## Key concepts

- **BRC-103 mutual authentication** — Nonce-based challenge-response with signatures
- **Ephemeral sockets** — Each Socket.IO connection creates new BRC-103 `Peer`
- **Session management** — Tracks nonces and auth state per socket via `SessionManager`
- **Certificate exchange** — Optional verifiable certificates during handshake
- **Message signing** — Outbound messages signed; inbound messages verified automatically
- **Special auth channel** — `'authMessage'` channel for BRC-103 frames; user code sees normal Socket.IO events

## When to use this

- Real-time applications requiring cryptographic identity verification
- Peer-to-peer communication with mutual authentication needs
- Applications where you need to verify sender identity without certificates
- Message-oriented services with signature-based security

## When NOT to use this

- Simple WebSocket communication without authentication — use Socket.IO directly
- If you need TLS certificate-based security — configure server TLS instead
- REST APIs with request/response auth — use `@bsv/auth-express-middleware`
- One-way broadcast channels — Server-Sent Events may be simpler

## Spec conformance

- **BRC-103** (Peer-to-Peer Mutual Authentication): Full handshake, nonce exchange, signature verification
- Uses BRC-103 `Peer` and `Transport` abstractions from SDK
- Session manager implements nonce replay protection

## Common pitfalls

1. **Wallet must be BRC-100 compatible** — needs `sign()` and `verify()` methods
2. **Certificate requests are optional** — if you don't request them, handshake is faster
3. **No auto-reconnect on server side** — client-side library handles reconnection logic
4. **Each socket is separate peer** — nonce state is per-socket; don't mix them
5. **CORS must be set explicitly** — Socket.IO requires `cors` config for browser clients

## Related packages

- **@bsv/authsocket-client** — Client-side counterpart; send messages to this server
- **@bsv/auth-express-middleware** — HTTP authentication for REST endpoints
- **@bsv/message-box-client** — Store-and-forward messaging using AuthSocketClient internally

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/authsocket/)
- [Source on GitHub](https://github.com/bsv-blockchain/authsocket)
- [npm](https://www.npmjs.com/package/@bsv/authsocket)
