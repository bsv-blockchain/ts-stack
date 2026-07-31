# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

## Interfaces

|                                                                         |
| ----------------------------------------------------------------------- |
| [AuthSocketClientErrorContext](#interface-authsocketclienterrorcontext) |
| [AuthSocketClientOptions](#interface-authsocketclientoptions)           |
| [SocketClientTransportOptions](#interface-socketclienttransportoptions) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: AuthSocketClientErrorContext

```ts
export interface AuthSocketClientErrorContext {
  phase: AuthSocketClientErrorPhase
  socketId?: string
  eventName?: string
}
```

See also: [AuthSocketClientErrorPhase](#type-authsocketclienterrorphase)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: AuthSocketClientOptions

```ts
export interface AuthSocketClientOptions {
  wallet: WalletInterface
  requestedCertificates?: RequestedCertificateSet
  sessionManager?: SessionManager | AsyncSessionManager
  managerOptions?: Partial<ManagerOptions & SocketOptions>
  originator?: OriginatorDomainNameStringUnder250Bytes
  maxPendingAuthMessages?: number
  onError?: AuthSocketClientErrorHandler
}
```

See also: [AuthSocketClientErrorHandler](#type-authsocketclienterrorhandler)

<details>

<summary>Interface AuthSocketClientOptions Details</summary>

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: SocketClientTransportOptions

```ts
export interface SocketClientTransportOptions {
  maxPendingMessages?: number
  onError?: (error: unknown) => void | Promise<void>
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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Functions

|                                                                        |
| ---------------------------------------------------------------------- |
| [AuthSocketClient](#function-authsocketclient)                         |
| [decodeAuthSocketEventPayload](#function-decodeauthsocketeventpayload) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

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

- **url**
  - The server URL
- **opts**
  - Contains wallet, requested certificates, and other optional settings

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

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

|                                                                    |
| ------------------------------------------------------------------ |
| [AuthSocketClientErrorHandler](#type-authsocketclienterrorhandler) |
| [AuthSocketClientErrorPhase](#type-authsocketclienterrorphase)     |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Type: AuthSocketClientErrorHandler

```ts
export type AuthSocketClientErrorHandler = (
  error: unknown,
  context: AuthSocketClientErrorContext
) => void | Promise<void>
```

See also: [AuthSocketClientErrorContext](#interface-authsocketclienterrorcontext)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Type: AuthSocketClientErrorPhase

```ts
export type AuthSocketClientErrorPhase = 'authentication' | 'application' | 'send'
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---
