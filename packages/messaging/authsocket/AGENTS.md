# CLAUDE.md — @bsv/authsocket

## Purpose
Server-side BRC-103 mutual authentication wrapper for Socket.IO. Enforces cryptographic signing and verification on all WebSocket messages, enabling peer-to-peer identity verification and certificate exchange.

## Public API surface

- **AuthSocketServer** (constructor): `new AuthSocketServer(httpServer, options)`
  - Wraps an HTTP server to add BRC-103 authentication to Socket.IO
  - Options: `wallet` (BRC-100 wallet), `cors` (Socket.IO CORS config), `sessionManager`, `certificatesToRequest`
  - Returns Socket.IO–like `io` object that emits authenticated `AuthSocket` instances on `'connection'`

- **AuthSocket** (event handlers): wraps native Socket.IO socket
  - `.on(eventName, callback)` — listen for authenticated messages
  - `.emit(eventName, data)` — send authenticated message
  - `.id` — socket ID (string)
  - Standard Socket.IO interface; all messages auto-signed/verified

- **SocketServerTransport** (internal): implements BRC-103 `Transport` interface
  - Receives raw BRC-103 frames via `socket.on('authMessage', ...)`
  - Routes to internal `Peer` for handshake/signature verification
  - Sends BRC-103 responses via `socket.emit('authMessage', ...)`

## Real usage patterns

From tests:
```ts
// Initialize server with wallet
const serverWallet = new ProtoWallet('my-private-key-hex')
const io = new AuthSocketServer(server, { wallet: serverWallet, cors: { origin: '*' } })

// Listen for authenticated connections
io.on('connection', (socket) => {
  console.log('Authenticated socket:', socket.id)
  
  // Receive message — signature verified automatically
  socket.on('chatMessage', (msg) => {
    console.log('Verified message:', msg)
  })
  
  // Send message — signed automatically
  socket.emit('chatMessage', { from: socket.id, text: 'Hello client' })
})

server.listen(3000)
```

Transport test:
```ts
const socket = createMockSocket()
const transport = new SocketServerTransport(socket)
const message = { type: 'test', payload: [1, 2, 3] }

await transport.send(message)
expect(socket.emit).toHaveBeenCalledWith('authMessage', message)

// Receiving messages
await transport.onData(callback)
socket._fire('authMessage', message)
expect(callback).toHaveBeenCalledWith(message)
```

## Key concepts

- **BRC-103 mutual authentication**: Nonce-based challenge-response with signatures
- **Ephemeral sockets**: Each new Socket.IO connection creates a new BRC-103 `Peer`
- **Session management**: Tracks nonces and authentication state per socket via `SessionManager`
- **Certificate exchange**: Supports requesting and verifying verifiable certificates during handshake
- **Message signing**: Every outbound message signed with server wallet; every inbound message verified
- **Automatic re-dispatch**: Special `'authMessage'` channel used for BRC-103 frames; user code sees normal Socket.IO events

## Dependencies

- `@bsv/sdk` ^2.0.14 — BRC-103 `Peer`, `Transport`, crypto utilities
- `socket.io` ^4.8.1 — WebSocket server
- Dev: jest, ts-jest, TypeScript

## Common pitfalls / gotchas

1. **Wallet must be BRC-100 compatible** — needs `sign()` and `verify()` methods
2. **Certificate requests optional** — if you don't request them, handshake is faster
3. **No auto-reconnect** — client-side library handles reconnection logic
4. **Each socket = separate peer** — nonce state is per-socket; don't mix them
5. **CORS must be set explicitly** — Socket.IO requires `cors` config for browser clients
6. **Async message handling** — all socket operations should `await` promises

## Spec conformance

- **BRC-103** (Peer-to-Peer Mutual Authentication): Full handshake, nonce exchange, signature verification
- Uses BRC-103 `Peer` and `Transport` abstractions from SDK
- Session manager implements nonce replay protection

## File map

```
/Users/personal/git/ts-stack/packages/messaging/authsocket/
  src/
    index.ts              — main exports (AuthSocketServer)
    AuthSocketServer.ts   — wraps Socket.IO with BRC-103
    AuthSocket.ts         — Socket.IO socket wrapper (signing/verification)
    SocketServerTransport.ts — BRC-103 Transport implementation
  tests/
    *.test.ts            — unit & integration tests
```

## Integration points

- **authsocket-client** — Paired with this package; client handles the socket.io-client + BRC-103 side
- **@bsv/sdk** — Supplies `Peer`, `Transport`, `SessionManager`, wallet abstractions
- **socket.io** — Underlying WebSocket transport layer
- Can be combined with `auth-express-middleware` on same server for HTTP + WS mutual auth
