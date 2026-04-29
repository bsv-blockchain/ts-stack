---
id: spec-authsocket
title: AuthSocket WebSocket Protocol
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "messaging", "websocket"]
---

# AuthSocket WebSocket Protocol

> AuthSocket wraps Socket.IO with BRC-103 mutual authentication. Every WebSocket connection undergoes a cryptographic handshake, then all application-level messages are automatically signed by the server and verified by the client (and vice versa). No shared secrets required—only identity public keys.

## Interactive spec

<AsyncApiEmbed slug="authsocket" />

## At a glance

| Field | Value |
|---|---|
| Format | AsyncAPI 3.0 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/authsocket |

## What problem this solves

**Authenticated real-time messaging over WebSocket**. WebSockets lack built-in authentication; clients typically send bearer tokens which are single-factor and session-based. AuthSocket brings BRC-103 mutual authentication to WebSocket: both client and server prove identity via cryptographic signatures, and every message is signed, preventing impersonation and tampering.

**Live message push without polling**. MessageBox's HTTP interface requires polling. AuthSocket enables server-side push: when a new message arrives, the server emits it immediately to the connected client without waiting for the next poll.

**Session-less design**. Each WebSocket connection is independent. The server doesn't maintain session state between connections. Authentication happens once at connect time; all subsequent messages are verified via signature.

## Protocol overview

**Two-phase connection**:

**Phase 1 — BRC-103 Handshake** (over low-level `authMessage` Socket.IO event)

1. **Client → Server** `socket.emit('authMessage', initialRequest)`
   - Client's public key
   - Client's nonce
   - Client signature over nonce

2. **Server → Client** `socket.emit('authMessage', initialResponse)`
   - Server's public key
   - Server's nonce (covering client's nonce)
   - Server signature

**Phase 2 — Authenticated Application Events**

After handshake, client and server exchange high-level events. All messages are wrapped in BRC-103 `general` type envelope and signed automatically:

- **Server → Client**: `socket.emit('messageReceived', { from, body, timestamp })`
- **Client → Server**: `socket.emit('sendMessage', { to, body })`
- Any JSON-serializable event; signature transparent to application code

## Key types / channels

| Channel | Direction | Message Type | Purpose |
|---------|-----------|--------------|---------|
| `authMessage` (low-level) | Bidirectional | `initialRequest` / `initialResponse` | BRC-103 handshake |
| Application events | Bidirectional | JSON objects | After handshake; auto-signed |

**Standard application events**:
- `messageReceived(message)` — Server pushes message to client
- `sendMessage(payload)` — Client sends message to server
- `joinRoom(roomName)` — Client joins subscription room
- `leaveRoom(roomName)` — Client leaves subscription room
- Any custom event name

## Example: Server setup

```typescript
import http from 'http'
import { AuthSocketServer } from '@bsv/authsocket'
import { SetupWallet } from '@bsv/wallet-toolbox'

const server = http.createServer()
const wallet = await SetupWallet({ env: 'main' })

// 1. Wrap HTTP server with BRC-103 authentication
const io = new AuthSocketServer(server, {
  wallet,
  cors: { origin: '*' }
})

// 2. Listen for authenticated connections
io.on('connection', (socket) => {
  console.log('Authenticated socket:', socket.id)
  
  // 3. Handle application events (signature verified automatically)
  socket.on('sendMessage', (msg) => {
    console.log('Received from:', socket.id, msg)
    
    // 4. Emit to other clients (server signs automatically)
    io.emit('messageReceived', {
      from: socket.id,
      body: msg.body,
      timestamp: new Date().toISOString()
    })
  })
})

server.listen(3000)
```

Example: Client subscription

```typescript
import { MessageBoxClient } from '@bsv/message-box-client'

const msgBox = new MessageBoxClient({ walletClient: wallet })

// Automatically handles BRC-103 handshake
await msgBox.listenForLiveMessages({
  messageBox: 'general_inbox',
  onMessage: (msg) => {
    console.log('Live message:', msg.body)
    // Message signature already verified server-side
  }
})

// Send message (client signs automatically)
msgBox.socket.emit('sendMessage', {
  body: 'Hello, live world!'
})
```

## Conformance vectors

AuthSocket conformance is tested in `conformance/vectors/messaging/authsocket/`:

- BRC-103 handshake on connection
- Signature generation and verification
- Event serialization/deserialization
- Room subscription logic
- Nonce management and freshness

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/authsocket | Server-side Socket.IO wrapper; provides `AuthSocketServer` class |
| @bsv/message-box-client | Client-side integration; uses authsocket for live messaging |
| @bsv/sdk | `Peer` and `Transport` abstractions underlying BRC-103 |

## Related specs

- [BRC-31 Auth](./brc-31-auth.md) — HTTP variant of the same mutual auth protocol
- [Message Box HTTP](./message-box-http.md) — Polling alternative (HTTP POST)
- [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/auth/0103.md) — Underlying peer authentication primitives

## Spec artifact

[authsocket-asyncapi.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/messaging/authsocket-asyncapi.yaml)
