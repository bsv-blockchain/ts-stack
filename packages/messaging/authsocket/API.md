# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

## Interfaces

### Interface: AuthSocketServerOptions

```ts
export interface AuthSocketServerOptions extends Partial<ServerOptions> {
    wallet: Wallet;
    requestedCertificates?: any;
    sessionManager?: SessionManager;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
## Classes

| |
| --- |
| [AuthSocket](#class-authsocket) |
| [AuthSocketServer](#class-authsocketserver) |
| [SocketClientTransport](#class-socketclienttransport) |
| [SocketServerTransport](#class-socketservertransport) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---

### Class: AuthSocket

A wrapper around a real `IoSocket` used by a server that performs BRC-103
signing and verification via the Peer class.

```ts
export class AuthSocket {
    constructor(public readonly ioSocket: IoSocket, private peer: Peer, private onIdentityKeyDiscovered: (socketId: string, identityKey: string) => void) 
    public on(eventName: string, callback: (data: any) => void) 
    public async emit(eventName: string, data: any): Promise<void> 
    get id(): string 
    get identityKey(): string | undefined 
}
```

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
public on(eventName: string, callback: (data: any) => void) 
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

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
    constructor(httpServer: HttpServer, private options: AuthSocketServerOptions) 
    public on(eventName: "connection", callback: (socket: AuthSocket) => void): void;
    public on(eventName: string, callback: (data: any) => void): void 
    public emit(eventName: string, data: any) 
}
```

See also: [AuthSocket](#class-authsocket), [AuthSocketServerOptions](#interface-authsocketserveroptions)

<details>

<summary>Class AuthSocketServer Details</summary>

#### Constructor

```ts
constructor(httpServer: HttpServer, private options: AuthSocketServerOptions) 
```
See also: [AuthSocketServerOptions](#interface-authsocketserveroptions)

Argument Details

+ **httpServer**
  + The underlying HTTP server
+ **options**
  + Contains both standard Socket.IO server config and BRC-103 config.

#### Method emit

Provide a classic pass-through to `io.emit(...)`.

Under the hood, we sign a separate BRC-103 AuthMessage for each 
authenticated peer. We'll embed eventName + data in the payload.

```ts
public emit(eventName: string, data: any) 
```

#### Method on

A direct pass-through to `io.on('connection', cb)`, 
but the callback is invoked with an AuthSocket instead.

```ts
public on(eventName: "connection", callback: (socket: AuthSocket) => void): void
```
See also: [AuthSocket](#class-authsocket)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
### Class: SocketClientTransport

```ts
export class SocketClientTransport implements Transport {
    constructor(private socket: IoClientSocket) 
    async send(message: AuthMessage): Promise<void> 
    async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> 
}
```

<details>

<summary>Class SocketClientTransport Details</summary>

#### Method onData

Register a callback to handle incoming AuthMessages.

```ts
async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> 
```

#### Method send

Send an AuthMessage to the server.

```ts
async send(message: AuthMessage): Promise<void> 
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
### Class: SocketServerTransport

Implements the Transport interface for a specific client socket.

This transport simply relays AuthMessages over 'authMessage'
in the underlying Socket.IO connection.

```ts
export class SocketServerTransport implements Transport {
    constructor(private socket: IoSocket) 
    async send(message: AuthMessage): Promise<void> 
    async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> 
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
## Functions

### Function: AuthSocketClient

Factory function for creating a new AuthSocketClientImpl instance.

```ts
export function AuthSocketClient(url: string, opts: {
    wallet: Wallet;
    requestedCertificates?: RequestedCertificateSet;
    sessionManager?: SessionManager;
    managerOptions?: Partial<ManagerOptions & SocketOptions>;
}): AuthSocketClientImpl 
```

<details>

<summary>Function AuthSocketClient Details</summary>

Argument Details

+ **url**
  + The server URL
+ **opts**
  + Contains wallet, requested certificates, and other optional settings

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
