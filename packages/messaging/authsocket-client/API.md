# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

## Interfaces

| |
| --- |
| [AuthSocketClientErrorContext](#interface-authsocketclienterrorcontext) |
| [AuthSocketClientOptions](#interface-authsocketclientoptions) |
| [SocketClientTransportOptions](#interface-socketclienttransportoptions) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

### Interface: AuthSocketClientErrorContext

```ts
export interface AuthSocketClientErrorContext {
    phase: AuthSocketClientErrorPhase;
    socketId?: string;
    eventName?: string;
}
```

See also: [AuthSocketClientErrorPhase](#type-authsocketclienterrorphase)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Interface: AuthSocketClientOptions

```ts
export interface AuthSocketClientOptions {
    wallet: WalletInterface;
    requestedCertificates?: RequestedCertificateSet;
    sessionManager?: SessionManager | AsyncSessionManager;
    managerOptions?: Partial<ManagerOptions & SocketOptions>;
    originator?: OriginatorDomainNameStringUnder250Bytes;
    maxPendingAuthMessages?: number;
    maxEventPayloadBytes?: number;
    expectedServerIdentityKey?: string;
    onError?: AuthSocketClientErrorHandler;
}
```

See also: [AuthSocketClientErrorHandler](#type-authsocketclienterrorhandler)

<details>

<summary>Interface AuthSocketClientOptions Details</summary>

#### Property expectedServerIdentityKey

Optional canonical BRC-103 identity pin for the expected server wallet.

```ts
expectedServerIdentityKey?: string
```

#### Property maxEventPayloadBytes

Maximum encoded bytes in one authenticated application event. Defaults to 1 MiB.

```ts
maxEventPayloadBytes?: number
```

#### Property maxPendingAuthMessages

Maximum authentication messages processed concurrently. Defaults to 32.

```ts
maxPendingAuthMessages?: number
```

#### Property onError

Receives contained transport and application errors without exposing remote payloads.

```ts
onError?: AuthSocketClientErrorHandler
```
See also: [AuthSocketClientErrorHandler](#type-authsocketclienterrorhandler)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Interface: SocketClientTransportOptions

```ts
export interface SocketClientTransportOptions {
    maxPendingMessages?: number;
    onError?: (error: unknown) => void | Promise<void>;
}
```

<details>

<summary>Interface SocketClientTransportOptions Details</summary>

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Classes

### Class: SocketClientTransport

```ts
export class SocketClientTransport implements Transport {
    constructor(private readonly socket: IoClientSocket, options: SocketClientTransportOptions = {})
    async send(message: AuthMessage): Promise<void>
    async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void>
}
```

See also: [SocketClientTransportOptions](#interface-socketclienttransportoptions)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Functions

| |
| --- |
| [AuthSocketClient](#function-authsocketclient) |
| [decodeAuthSocketEventPayload](#function-decodeauthsocketeventpayload) |
| [encodeAuthSocketEventPayload](#function-encodeauthsocketeventpayload) |
| [parseAuthSocketEventPayload](#function-parseauthsocketeventpayload) |
| [resolveMaxEventPayloadBytes](#function-resolvemaxeventpayloadbytes) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

### Function: AuthSocketClient

Factory function for creating a new AuthSocketClientImpl instance.

```ts
export function AuthSocketClient(url: string, opts: AuthSocketClientOptions): AuthSocketClientImpl
```

See also: [AuthSocketClientOptions](#interface-authsocketclientoptions)

<details>

<summary>Function AuthSocketClient Details</summary>

Argument Details

+ **url**
  + The server URL
+ **opts**
  + Contains wallet, requested certificates, and other optional settings

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: decodeAuthSocketEventPayload

```ts
export function decodeAuthSocketEventPayload(payload: number[]): {
    eventName: string;
    data: any;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: encodeAuthSocketEventPayload

```ts
export function encodeAuthSocketEventPayload(eventName: string, data: unknown, maxBytes: number): number[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: parseAuthSocketEventPayload

```ts
export function parseAuthSocketEventPayload(payload: unknown, maxBytes: number): {
    eventName: string;
    data: unknown;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: resolveMaxEventPayloadBytes

```ts
export function resolveMaxEventPayloadBytes(value: number | undefined): number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Types

| |
| --- |
| [AuthSocketClientErrorHandler](#type-authsocketclienterrorhandler) |
| [AuthSocketClientErrorPhase](#type-authsocketclienterrorphase) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

### Type: AuthSocketClientErrorHandler

```ts
export type AuthSocketClientErrorHandler = (error: unknown, context: AuthSocketClientErrorContext) => void | Promise<void>
```

See also: [AuthSocketClientErrorContext](#interface-authsocketclienterrorcontext)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Type: AuthSocketClientErrorPhase

```ts
export type AuthSocketClientErrorPhase = "authentication" | "application" | "send"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Variables

### Variable: DEFAULT_MAX_EVENT_PAYLOAD_BYTES

```ts
DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
