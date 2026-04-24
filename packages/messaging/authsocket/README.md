# AuthSocket (server-side)

## Overview

This repository provides a **drop-in server-side solution** for Socket.IO that enforces [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md) **mutual authentication** on all connected clients. 

- Each client message is **signed** using BRC-103 message format.  
- The server **verifies** each message upon receipt.  
- The server also **signs** its outbound messages, so clients can verify authenticity.  

It pairs seamlessly with the [`authsocket-client`](https://github.com/.../authsocket-client) library, which handles the client side of this handshake. However, if you are building your own client logic, you only need to ensure it also speaks BRC-103 and can sign/verify messages accordingly.

## Installation

1. **Install** the package (and its dependencies):
   ```bash
   npm install
   ```
2. Ensure you have a BRC-103-compatible `Wallet` implementation (for instance from `@bsv/sdk` or your own custom code) that can sign and verify messages.

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
```

1. Create an `AuthSocketServer` with the `wallet` option.  
2. On `'connection'`, you receive an `AuthSocket` instance that works like a normal Socket.IO socket: `socket.on(...)`, `socket.emit(...)`, etc.  
3. All messages are automatically signed and verified under the hood.

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