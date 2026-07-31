# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

## Interfaces

|                                                                         |
| ----------------------------------------------------------------------- |
| [AuthSocketErrorContext](#interface-authsocketerrorcontext)             |
| [AuthSocketServerOptions](#interface-authsocketserveroptions)           |
| [SocketServerTransportOptions](#interface-socketservertransportoptions) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: AuthSocketErrorContext

```ts
export interface AuthSocketErrorContext {
  phase: AuthSocketErrorPhase
  socketId?: string
  eventName?: string
}
```

See also: [AuthSocketErrorPhase](#type-authsocketerrorphase)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: AuthSocketServerOptions

```ts
export interface AuthSocketServerOptions extends Partial<ServerOptions> {
  wallet: WalletInterface
  requestedCertificates?: any
  sessionManager?: SessionManager | AsyncSessionManager
  maxPendingAuthMessages?: number
  onError?: AuthSocketErrorHandler
}
```

See also: [AuthSocketErrorHandler](#type-authsocketerrorhandler)

<details>

<summary>Interface AuthSocketServerOptions Details</summary>

#### Property maxPendingAuthMessages

Maximum authentication messages processed concurrently by each socket. Defaults to 32.

```ts
maxPendingAuthMessages?: number
```

#### Property onError

Receives contained transport and application errors without exposing remote payloads.

```ts
onError?: AuthSocketErrorHandler
```

See also: [AuthSocketErrorHandler](#type-authsocketerrorhandler)

#### Property sessionManager

Optional shared BRC-103 session store. Use an AsyncSessionManager backed by
a shared database when more than one server replica handles connections.

```ts
sessionManager?: SessionManager | AsyncSessionManager
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: SocketServerTransportOptions

```ts
export interface SocketServerTransportOptions {
  maxPendingMessages?: number
  onError?: (error: unknown) => void | Promise<void>
}
```

<details>

<summary>Interface SocketServerTransportOptions Details</summary>

#### Property maxPendingMessages

Maximum authentication messages that may be processed concurrently per socket.

```ts
maxPendingMessages?: number
```

#### Property onError

Receives contained authentication failures. The hook is never allowed to throw outward.

```ts
onError?: (error: unknown) => void | Promise<void>
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Classes

|                                                       |
| ----------------------------------------------------- |
| [AuthSocket](#class-authsocket)                       |
| [AuthSocketServer](#class-authsocketserver)           |
| [SocketServerTransport](#class-socketservertransport) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Class: AuthSocket

A wrapper around a real `IoSocket` used by a server that performs BRC-103
signing and verification via the Peer class.

```ts
export class AuthSocket {
    constructor(public readonly ioSocket: IoSocket, private readonly peer: Peer, private readonly onIdentityKeyDiscovered: (socketId: string, identityKey: string) => void, private readonly onError: AuthSocketErrorHandler = () => { })
    public on(eventName: string, callback: (data: any) => void | Promise<void>)
    public async emit(eventName: string, data: any): Promise<void>
    get id(): string
    get identityKey(): string | undefined
}
```

See also: [AuthSocketErrorHandler](#type-authsocketerrorhandler)

<details>

<summary>Class AuthSocket Details</summary>

#### Method emit

Emulate `socket.emit(eventName, data)`.
We'll sign a BRC-103 `general` message via Peer,
embedding the event name & data in the payload.

If we do not yet have the peer's identity key (handshake not done?),
the Peer will attempt the handshake. Once known, subsequent calls
will pass identityKey to skip the initial handshake.

```ts
public async emit(eventName: string, data: any): Promise<void>
```

#### Method on

Register a callback for an event name, just like `socket.on(...)`.

```ts
public on(eventName: string, callback: (data: any) => void | Promise<void>)
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Class: AuthSocketServer

A server-side wrapper for Socket.IO that integrates BRC-103 mutual authentication
to ensure secure, identity-aware communication between clients and the server.

This class functions as a drop-in replacement for the `Server` class from Socket.IO,
with added support for:

- Automatic BRC-103 handshake for secure client authentication.
- Management of authenticated client sessions, avoiding redundant handshakes.
- Event-based communication through signed and verified BRC-103 messages.

Features:

- Tracks client connections and their associated `Peer` and `AuthSocket` instances.
- Allows broadcasting messages to all authenticated clients.
- Provides a seamless API for developers by wrapping Socket.IO functionality.

```ts
export class AuthSocketServer {
    constructor(httpServer: HttpServer, private readonly options: AuthSocketServerOptions)
    public on(eventName: "connection", callback: (socket: AuthSocket) => void | Promise<void>): void;
    public on(eventName: string, callback: (data: any) => void | Promise<void>): void;
    public on(eventName: string, callback: (data: any) => void | Promise<void>): void
    public emit(eventName: string, data: any)
    public emitToIdentity(identityKey: string, eventName: string, data: any): number
    public close(): Promise<void>
}
```

See also: [AuthSocket](#class-authsocket), [AuthSocketServerOptions](#interface-authsocketserveroptions)

<details>

<summary>Class AuthSocketServer Details</summary>

#### Constructor

```ts
constructor(httpServer: HttpServer, private readonly options: AuthSocketServerOptions)
```

See also: [AuthSocketServerOptions](#interface-authsocketserveroptions)

Argument Details

- **httpServer**
  - The underlying HTTP server
- **options**
  - Contains both standard Socket.IO server config and BRC-103 config.

#### Method close

Stops accepting connections, disconnects active sockets, and closes the
attached HTTP server. Repeated calls share the same shutdown operation.

```ts
public close(): Promise<void>
```

#### Method emit

Provide a classic pass-through to `io.emit(...)`.

Under the hood, we sign a separate BRC-103 AuthMessage for each
authenticated peer. We'll embed eventName + data in the payload.

```ts
public emit(eventName: string, data: any)
```

#### Method emitToIdentity

Emit only to connections whose cryptographically authenticated peer
identity matches the requested identity key.

This is safer than application-level "room" names for private delivery:
a client cannot subscribe itself to another identity because the routing
decision uses the key discovered by the BRC-103 handshake.

```ts
public emitToIdentity(identityKey: string, eventName: string, data: any): number
```

Returns

the number of authenticated connections selected for delivery

#### Method on

A direct pass-through to `io.on('connection', cb)`,
but the callback is invoked with an AuthSocket instead.

```ts
public on(eventName: "connection", callback: (socket: AuthSocket) => void | Promise<void>): void
```

See also: [AuthSocket](#class-authsocket)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Class: SocketServerTransport

Implements the Transport interface for a specific client socket.

This transport simply relays AuthMessages over 'authMessage'
in the underlying Socket.IO connection.

```ts
export class SocketServerTransport implements Transport {
    constructor(private readonly socket: IoSocket, options: SocketServerTransportOptions = {})
    async send(message: AuthMessage): Promise<void>
    async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void>
}
```

See also: [SocketServerTransportOptions](#interface-socketservertransportoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Functions

### Function: decodeAuthSocketEventPayload

```ts
export function decodeAuthSocketEventPayload(payload: number[]): {
  eventName: string
  data: any
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Types

|                                                        |
| ------------------------------------------------------ |
| [AuthSocketErrorHandler](#type-authsocketerrorhandler) |
| [AuthSocketErrorPhase](#type-authsocketerrorphase)     |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Type: AuthSocketErrorHandler

```ts
export type AuthSocketErrorHandler = (
  error: unknown,
  context: AuthSocketErrorContext
) => void | Promise<void>
```

See also: [AuthSocketErrorContext](#interface-authsocketerrorcontext)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Type: AuthSocketErrorPhase

```ts
export type AuthSocketErrorPhase = 'authentication' | 'application' | 'connection' | 'send'
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---
