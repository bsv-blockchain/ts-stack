# CLAUDE.md — @bsv/authsocket-client

## Purpose
Client-side BRC-103 mutual authentication wrapper for socket.io-client. Signs all outbound messages and verifies inbound messages using a wallet, enabling authenticated peer-to-peer WebSocket communication.

## Public API surface

- **AuthSocketClient** (function): `AuthSocketClient(serverUrl, options)`
  - Wraps socket.io-client with BRC-103 authentication
  - Options: `wallet` (BRC-100 wallet), `managerOptions` (Socket.IO manager options)
  - Returns proxy-like socket object with `.on()`, `.emit()`, `.id`, `.connect()`, `.disconnect()`
  - All messages automatically signed with client wallet key

- **SocketClientTransport** (internal): implements BRC-103 `Transport` interface
  - Receives raw BRC-103 frames via `socket.on('authMessage', ...)`
  - Routes to internal `Peer` for handshake/signature verification
  - Sends BRC-103 responses via `socket.emit('authMessage', ...)`

## Real usage patterns

From README:
```ts
import { AuthSocketClient } from '@bsv/authsocket-client'
import { ProtoWallet } from '@bsv/sdk'

// Load client wallet
const clientWallet = new ProtoWallet('client-private-key-hex')

// Create authenticated socket
const socket = AuthSocketClient('http://localhost:3000', { wallet: clientWallet })

// Standard Socket.IO usage — messages auto-signed
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

## Key concepts

- **BRC-103 mutual authentication**: Nonce-based challenge-response protocol
- **Ephemeral nonces**: Each outbound message includes fresh nonce + signature
- **Signature verification**: Inbound messages verified against server's public key
- **Session binding**: Server nonce proves server identity; client nonce proves client identity
- **Certificate exchange**: Supports verifiable certificates during handshake (optional)
- **Transparent proxying**: User code interacts with normal Socket.IO API; BRC-103 is hidden

## Dependencies

- `@bsv/sdk` ^2.0.14 — BRC-103 `Peer`, `Transport`, crypto, wallet
- `socket.io-client` ^4.8.1 — WebSocket client
- Dev: jest, ts-jest, TypeScript

## Common pitfalls / gotchas

1. **Wallet must be BRC-100 compatible** — needs `sign()` and `verify()` methods for identity
2. **Server must also support BRC-103** — use `@bsv/authsocket` or implement BRC-103 `Peer` yourself
3. **Nonce tracking** — library auto-generates nonces; don't manually set them
4. **Signature verification** — inbound messages automatically verified; if verification fails, message is dropped
5. **Connection state** — `.connect()` and `.disconnect()` trigger standard Socket.IO lifecycle
6. **Message order** — BRC-103 handshake must complete before general messages; library handles this

## Spec conformance

- **BRC-103** (Peer-to-Peer Mutual Authentication): Full handshake, nonce exchange, signature verification, optional certificate exchange
- Uses BRC-103 `Peer` and `Transport` abstractions from SDK
- Client transport implements ephemeral nonce generation + signing

## File map

```
/Users/personal/git/ts-stack/packages/messaging/authsocket-client/
  src/
    index.ts              — main exports (AuthSocketClient)
    AuthSocketClient.ts   — function wrapping socket.io-client
    SocketClientTransport.ts — BRC-103 Transport implementation
  tests/
    *.test.ts            — unit & integration tests
```

## Integration points

- **authsocket** — Paired server-side package; together they form end-to-end BRC-103 WebSocket auth
- **@bsv/sdk** — Supplies `Peer`, `Transport`, wallet interfaces, crypto utilities
- **socket.io-client** — Underlying WebSocket client library
- **message-box-client** — Uses `AuthSocketClient` for live message delivery
