# AuthSocket (server-side)

## Overview

This package provides a **drop-in server-side solution** for Socket.IO that enforces [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md) **mutual authentication** on all connected clients.

- Each client message is **signed** using the BRC-103 message format.
- The server **verifies** each message upon receipt.
- The server also **signs** its outbound messages, so clients can verify authenticity.

It pairs with
[`@bsv/authsocket-client`](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/authsocket-client),
which handles the client side of this handshake. A custom client can also
connect if it implements the same BRC-103 signing and verification protocol.

## Installation

Install the server and its required SDK peer:

```bash
npm install @bsv/authsocket @bsv/sdk
```

Provide a BRC-103-compatible `Wallet` implementation, such as one from
`@bsv/sdk`, that can sign and verify messages.

## Usage

Below is a minimal **Express** + **HTTP** + **Socket.IO** + `authsocket` server. You can adapt it to your own setup (e.g. Fastify, Koa, etc.) since only the raw `http.Server` is needed for Socket.IO.

```ts
import express from 'express'
import http from 'http'
import { AuthSocketServer } from '@bsv/authsocket'
import { ProtoWallet } from '@bsv/sdk' // your BRC-103 compatible wallet

const app = express()
const server = http.createServer(app)
const port = 3000

// Example: create or load your BRC-103 wallet
const serverWallet = new ProtoWallet('my-private-key-hex')

// Wrap your HTTP server with AuthSocketServer
// which internally wraps the Socket.IO server.
const io = new AuthSocketServer(server, {
  wallet: serverWallet,
  cors: {
    origin: '*'
  }
})

// Use it like standard Socket.IO
io.on('connection', (socket) => {
  console.log('New Authenticated Connection -> socket ID:', socket.id)

  // Listen for chat messages
  socket.on('chatMessage', (msg) => {
    console.log('Received message from client:', msg)
    // Reply to the client
    socket.emit('chatMessage', { from: socket.id, text: 'Hello from server!' })
  })

  socket.on('disconnect', () => {
    console.log(`Socket ${socket.id} disconnected`)
  })
})

server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})

process.once('SIGTERM', () => {
  void io.close()
})
```

The `cors` setting belongs to Socket.IO and is intentionally configurable.
Public Overlays, WAB, Storage, and other cross-domain services can remain
accessible with `origin: '*'`; deployments with a closed caller set can supply
an explicit allowlist instead. AuthSocket does not impose a restrictive
cross-origin default of its own.

1. Create an `AuthSocketServer` with the `wallet` option.
2. On `'connection'`, receive an `AuthSocket` that supports normal
   `socket.on(...)` and `socket.emit(...)` calls.
3. Messages are signed and verified under the hood.

Call `await io.close()` during shutdown. It is idempotent and disconnects
active Socket.IO clients before closing the attached HTTP server.

### Targeted authenticated delivery

Use `emitToIdentity` when a message is private to one BRC-103 identity:

```ts
const selectedConnections = io.emitToIdentity(
  recipientIdentityKey,
  'message',
  encryptedPayload
)
```

The routing decision uses the peer identity discovered by the signed
transport, not a caller-provided room or payload claim. The return value is
the number of authenticated connections selected. `emit` remains a broadcast
operation and should be reserved for intentionally public events.

### How It Works (Briefly)

- On each new connection, `AuthSocketServer` sets up a **BRC-103** `Peer` with a corresponding transport (`SocketServerTransport`).
- Incoming messages on a special `'authMessage'` channel are processed for authenticity and re-dispatched as your normal `'chatMessage'` (or any other event name).
- Outgoing messages from your code pass through the same **Peer** to be signed before being sent to the client.

## Detailed Explanations

### AuthSocketServer & AuthSocket

- **`AuthSocketServer`**:
  - Internally wraps a normal Socket.IO server.
  - On each new client connection, it:
    1. Instantiates a `SocketServerTransport`.
    2. Creates a new BRC-103 `Peer` for that connection.
    3. Wraps the Socket.IO socket in an `AuthSocket` for your convenience.
  - Maintains a mapping of connected sockets by `socket.id` with their associated `Peer`.

- **`AuthSocket`**:
  - A thin wrapper that provides `on(eventName, callback)` and `emit(eventName, data)` (just like a normal Socket.IO socket).
  - Internally, it uses the BRC-103 `Peer` to sign outbound messages and verify inbound ones.

### SocketServerTransport
- Implements the **BRC-103** `Transport` interface for server-side usage.
- Receives messages via `socket.on('authMessage', ...)` from the Socket.IO layer.
- Passes them to the `Peer` for handshake steps (signature verification, certificate exchange, etc.).
- Sends BRC-103 messages back to the client via `socket.emit('authMessage', ...)`.

## License

See [LICENSE.txt](./LICENSE.txt).

## Development and distribution

This package publishes Node.js ESM and CommonJS entry points, source maps, and
declarations for both module systems. Pull requests and releases should run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
pnpm pack:check
```

`pack:check` validates the exact npm tarball with `publint`, strict ESM and
CommonJS type resolution, and clean consumer installations. The package uses
the Open BSV License Version 6; the repository license controls ensure the
manifest, included license, and packed artifact remain in sync.
