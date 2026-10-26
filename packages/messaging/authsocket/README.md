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

Below is a minimal loopback **Express** + **HTTP** + **Socket.IO** +
`authsocket` server. Production deployments must terminate TLS at this process
or a trusted reverse proxy; BRC-103 authenticates messages but does not encrypt
their payloads or Socket.IO metadata. You can adapt the example to another HTTP
framework because only the raw `http.Server` is needed for Socket.IO.

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
  onError: (error, context) => {
    // Send the error to your private telemetry sink. Context never includes
    // the remote payload or wallet material.
    console.error(context.phase, context.socketId, error)
  },
  cors: {
    origin: '*'
  }
})

// Use it like standard Socket.IO
io.on('connection', socket => {
  console.log('New Authenticated Connection -> socket ID:', socket.id)

  // Listen for chat messages
  socket.on('chatMessage', msg => {
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

It is a browser-origin policy, not authentication or authorization. Authorize
each authenticated BRC-103 identity for the requested operation in application
code.

1. Create an `AuthSocketServer` with the `wallet` option.
2. On `'connection'`, receive an `AuthSocket` that supports normal
   `socket.on(...)` and `socket.emit(...)` calls.
3. Messages are signed and verified under the hood.

The application `'connection'` callback runs only after the client proves its
claimed identity with its first verified signed message. That first event waits
for all connection callbacks, and every concurrently received event shares that
same activation gate, so handlers can be installed or the connection can be
denied before any application dispatch. A peer is not eligible for broadcast or
identity-targeted delivery until activation finishes. Unauthenticated transport
connections are excluded from broadcasts and never receive an application
`AuthSocket`. A registered `'disconnect'` handler reports the underlying
Socket.IO disconnect; a signed application event cannot spoof it.

Authenticated event data preserves supported JSON exactly, including plain
numeric-key objects under names such as `data`, `payload`, `transaction`, and
`tx`. Real `Uint8Array` values are serialized as portable number arrays. Code
that owns a typed payment or wallet protocol may recover a historical
numeric-key byte object at that protocol's explicit byte field after receipt.
Non-JSON values, negative zero, nested `undefined`, accessors, hidden/extra
properties, sparse arrays, and serialization hooks are rejected before signing
so the validated object cannot change meaning or expand work during encoding.

`requestedCertificates` configures the SDK's v0.1 certificate allowlist, not a
complete application authorization policy. The legacy shape cannot express
all/any/optional/threshold fulfillment, and this wrapper does not expose the
received evidence to the connection callback. Do not grant application access
merely because this option was configured; authorize the authenticated identity
independently, or use an integration that exposes validated certificate fields
for an explicit application decision.

Call `await io.close()` during shutdown. It is idempotent and disconnects
active Socket.IO clients before closing the attached HTTP server.

### Failure isolation and resource limits

Authentication frames and application callbacks are isolated per connection.
If signature verification, certificate handling, a connection callback, or an
event callback throws or rejects, AuthSocket contains the failure and
disconnects only that socket. The optional `onError(error, context)` hook
receives a phase, socket ID, and event name where applicable; a hook that
throws or rejects is also contained. Raw payloads and wallet data are not added
to the context.

At most 32 authentication messages are processed concurrently per socket by
default. Set `maxPendingAuthMessages` to a positive safe integer when a
deployment needs a different per-connection bound. A client that exceeds the
bound is disconnected while the server continues accepting other clients.

Authenticated application frames default to a 1 MiB encoded limit. Set
`maxEventPayloadBytes` to another positive safe integer if necessary. Event
names are bounded and may not use Socket.IO lifecycle names or the internal
`_unknown` sentinel. Malformed, oversized, or reserved-name frames disconnect
only the offending socket and are never dispatched to application handlers.

The default SDK session manager retains at most 10,000 sessions for 30 minutes
of idle time and consumes each signed message nonce once. A custom shared
`AsyncSessionManager` must implement atomic `claimMessageNonce`; the SDK fails
closed if it does not. It must also atomically implement
`claimInitialRequestNonce` so unsigned handshake replays are rejected before
wallet or callback work. Wallet Toolbox's `KnexSessionManager` provides both
contracts after its replay-claim migration has run.

### Targeted authenticated delivery

Use `emitToIdentity` when a message is private to one BRC-103 identity:

```ts
const selectedConnections = io.emitToIdentity(recipientIdentityKey, 'message', encryptedPayload)
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
- Contains rejected handshake processing and disconnects the offending socket.
- Sends BRC-103 messages back to the client via `socket.emit('authMessage', ...)`.

## License

Current TS Stack changes are licensed under the Open BSV License Version 6; see
[LICENSE.txt](./LICENSE.txt). This package also retains pre-uniformization code
under the Open BSV License Version 4. Redistributors must preserve
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and the applicable text in
[`LICENSES/`](./LICENSES/).

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
