# AuthSocket (client-side)

## Overview

This package provides a **drop-in client-side solution** for Socket.IO that
**signs** outbound messages and **verifies** inbound messages using
[BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md).

- Works with
  [`@bsv/authsocket`](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/authsocket)
  or any BRC-103-compatible server.
- Minimal changes compared to normal `socket.io-client` usage.

## Next release candidate

Unpublished 2.1.8 refreshes the UMD browser bundle with the integrated SDK.
AuthSocket APIs, signed event JSON and the ESM/CommonJS SDK peer range are
unchanged. The rebuilt UMD bytes differ from published 2.1.7, so distributors
should adopt the new artifact only after publication and retain its license
notices. Current wallet release pins are unaffected.

## Installation

Install the client and its required SDK peer:

```bash
npm install @bsv/authsocket-client @bsv/sdk
```

Provide a BRC-103-compatible `Wallet`, such as one from `@bsv/sdk`.

## Usage

Below is a minimal client code that wraps `socket.io-client`:

```ts
import { AuthSocketClient } from '@bsv/authsocket-client'
import { ProtoWallet } from '@bsv/sdk' // your BRC-103-compatible wallet

// Create or load your local BRC-103 wallet
const clientWallet = new ProtoWallet('client-private-key-hex')

// Wrap the normal Socket.IO client with AuthSocketClient
const socket = AuthSocketClient('http://localhost:3000', {
  wallet: clientWallet,
  onError: (error, context) => {
    // Context identifies the phase and event without copying the remote payload.
    console.error(context.phase, context.eventName, error)
  }
})

// Standard Socket.IO usage
socket.on('connect', () => {
  console.log('Socket.IO transport connected. Socket ID:', socket.id)

  // Emit a sample message
  socket.emit('chatMessage', {
    text: 'Hello from client!'
  })
})

socket.on('chatMessage', msg => {
  console.log('Server says:', msg)
})

socket.on('disconnect', () => {
  console.log('Disconnected from server')
})
```

1. Use `AuthSocketClient(serverUrl, options)` to create a BRC-103-secured socket client.
2. Interact with `.on(...)`, `.emit(...)` as normal.
3. Behind the scenes, each message is signed with your client wallet key and verified by the server. Inbound messages are also verified.

The standard `connect` event and `connected` property report only the underlying
Socket.IO transport. They do not assert that the server has completed BRC-103
authentication. An outbound application `emit` performs the handshake before
its signed general message is sent; inbound application callbacks run only for
verified general messages. For local side effects that require a known server,
configure `expectedServerIdentityKey` and wait for a verified application event,
not merely `connect`.

Remote endpoints must use `https://` or `wss://`; cleartext is accepted only
for exact loopback hosts. BRC-103 authenticates messages but does not encrypt
payloads or Socket.IO metadata, so TLS remains mandatory in production. The
optional `expectedServerIdentityKey` binds the connection to a known canonical
BRC-103 server identity. When omitted, the client binds to the identity on the
first verified application message for that connection. URL-authority and TLS
verification overrides in `managerOptions` are rejected; use a trusted custom
CA while retaining certificate verification for private PKI.

Authenticated event data preserves supported JSON exactly, including plain
numeric-key objects under names such as `data`, `payload`, `transaction`, and
`tx`. Real `Uint8Array` values are serialized as portable number arrays. Code
that owns a typed payment or wallet protocol may recover a historical
numeric-key byte object at that protocol's explicit byte field after receipt.
Non-JSON values, negative zero, nested `undefined`, accessors, hidden/extra
properties, sparse arrays, and serialization hooks are rejected before signing.

### Failure isolation and resource limits

Authentication frames and application callbacks are contained inside the
client connection. If a server sends a frame that fails BRC-103 processing, or
an event callback throws or rejects, the client disconnects without creating
an unhandled promise rejection. The optional `onError(error, context)` hook is
also isolated if it throws or rejects, and its context does not include remote
payloads or wallet material.

The client processes at most 32 authentication messages concurrently by
default. Set `maxPendingAuthMessages` to a positive safe integer to choose a
different bound; a server that exceeds it is disconnected.

Authenticated application frames default to a 1 MiB encoded limit. Set
`maxEventPayloadBytes` to another positive safe integer if needed. Event names
are bounded and cannot use Socket.IO lifecycle names or the internal `_unknown`
sentinel. Malformed, oversized, or reserved-name frames are not dispatched.

### How It Works (Briefly)

- `AuthSocketClient` creates an internal BRC-103 `Peer` that handles:
  - Generating ephemeral nonces and signatures for each outbound message.
  - Verifying inbound messages from the server using the server’s public key.
- A special `'authMessage'` channel is used for the underlying BRC-103 handshake. You only interact with standard Socket.IO event names (like `'chatMessage'`), as `AuthSocketClient` automatically re-dispatches them.

## Detailed Explanations

### SocketClientTransport

- Implements the **BRC-103** `Transport` interface on the client side.
- Relies on the underlying `socket.io-client` for raw message passing via the `'authMessage'` channel.
- The BRC-103 `Peer` calls this transport to send and receive raw BRC-103 frames.
- Rejected or synchronous authentication failures are contained before they can become unhandled rejections.

### AuthSocketClient

- A function that returns a proxy-like client socket.
- Inside, it:
  1. Creates a real `io(url, managerOptions)` from `socket.io-client`.
  2. Attaches a `SocketClientTransport`.
  3. Creates a `Peer` with your `wallet`.
  4. Provides the final object with `.on(eventName, callback)` and `.emit(eventName, data)` methods.

---

> **Note**: If you want to see a **full end-to-end** example, combine the server code from the `authsocket` README with the client code from the `authsocket-client` README, then run both. You should see messages securely exchanged and logs showing mutual authentication in action.

## License

TS Stack first-party material is under the [Open BSV License Version 6](./LICENSE.txt).
The UMD bundle incorporates separately licensed SDK material; keep
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and [LICENSES/](./LICENSES/)
with the bundle.

## Development and distribution

The npm tarball contains browser-targeted ESM and CommonJS entry points, source
maps, declarations for both module systems, and a UMD build. Pull requests and
releases should run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
pnpm pack:check
pnpm test:browser
```

`pack:check` validates the exact npm tarball with `publint`, strict ESM and
CommonJS type resolution, and clean consumer installations. `test:browser`
verifies the packed package with Vite, esbuild, and the UMD artifact and
enforces the repository's compressed-size budgets. The package uses the Open
BSV License Version 6; the repository license controls ensure the manifest,
included license, and packed artifact remain in sync.
