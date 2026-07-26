# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

## Interfaces

|                                                           |
| --------------------------------------------------------- |
| [AuthMiddlewareOptions](#interface-authmiddlewareoptions) |
| [AuthRequest](#interface-authrequest)                     |
| [AuthTransportLimits](#interface-authtransportlimits)     |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: AuthMiddlewareOptions

```ts
export interface AuthMiddlewareOptions {
  wallet: WalletInterface
  sessionManager?: SessionManager | AsyncSessionManager
  allowUnauthenticated?: boolean
  certificatesToRequest?: RequestedCertificateSet
  onCertificatesReceived?: (
    senderPublicKey: string,
    certs: VerifiableCertificate[],
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => void | Promise<void>
  logger?: typeof console
  logLevel?: LogLevel
  transportLimits?: Partial<AuthTransportLimits>
}
```

See also: [AuthRequest](#interface-authrequest), [AuthTransportLimits](#interface-authtransportlimits), [LogLevel](#type-loglevel)

<details>

<summary>Interface AuthMiddlewareOptions Details</summary>

#### Property logLevel

Optional logging level. Defaults to no logging if not provided.
'debug' | 'info' | 'warn' | 'error'

- debug: Logs detailed lifecycle metadata without secret-bearing payloads.
- info: Logs general informational messages about normal operation.
- warn: Logs potential issues but not necessarily errors.
- error: Logs only critical issues and errors.

```ts
logLevel?: LogLevel
```

See also: [LogLevel](#type-loglevel)

#### Property logger

Optional logger (e.g., console). If not provided, logging is disabled.

```ts
logger?: typeof console
```

#### Property transportLimits

Bounds unauthenticated work and pending protocol state. Defaults to a
30-second timeout and 1,000 concurrent request records per process.

```ts
transportLimits?: Partial<AuthTransportLimits>
```

See also: [AuthTransportLimits](#interface-authtransportlimits)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: AuthRequest

```ts
export interface AuthRequest extends Request {
  auth?: {
    identityKey: PubKeyHex
  }
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Interface: AuthTransportLimits

```ts
export interface AuthTransportLimits {
  requestTimeoutMs: number
  maxPendingRequests: number
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Classes

### Class: ExpressTransport

Transport implementation for Express.

```ts
export class ExpressTransport implements Transport {
  peer?: Peer
  allowUnauthenticated: boolean
  openNonGeneralHandles = new Map<string, PendingHandle[]>()
  openGeneralHandles = new Map<
    string,
    {
      next: Function
      res: Response
    }
  >()
  openNextHandlers = new Map<string, NextFunction>()
  openNextHandlerTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    allowUnauthenticated: boolean = false,
    logger?: typeof console,
    logLevel?: LogLevel,
    limits: Partial<AuthTransportLimits> = {}
  )
  get allowAuthenticated(): boolean
  set allowAuthenticated(value: boolean)
  setPeer(peer: Peer): void
  async send(message: AuthMessage): Promise<void>
  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void>
  public async handleIncomingRequest(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
    onCertificatesReceived?: (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      req: AuthRequest,
      res: Response,
      next: NextFunction
    ) => void | Promise<void>
  ): Promise<void>
}
```

See also: [AuthRequest](#interface-authrequest), [AuthTransportLimits](#interface-authtransportlimits), [LogLevel](#type-loglevel)

<details>

<summary>Class ExpressTransport Details</summary>

#### Constructor

Constructs a new ExpressTransport instance.

```ts
constructor(allowUnauthenticated: boolean = false, logger?: typeof console, logLevel?: LogLevel, limits: Partial<AuthTransportLimits> = {})
```

See also: [AuthTransportLimits](#interface-authtransportlimits), [LogLevel](#type-loglevel)

Argument Details

- **allowUnauthenticated**
  - Whether to allow unauthenticated requests passed the auth middleware.
    If `true`, requests without authentication will be permitted, and `req.auth.identityKey`
    will be set to `"unknown"`. If `false`, unauthenticated requests will result in a `401 Unauthorized` response.
- **logger**
  - Logger to use (e.g., console). If omitted, logging is disabled.
- **logLevel**
  - Log level. If omitted, no logs are output.

#### Method handleIncomingRequest

Handles an incoming request for the Express server.

This method processes both general and non-general message types,
manages peer-to-peer certificate handling, and modifies the response object
to enable custom behaviors like certificate requests and tailored responses.

### Behavior:

- For `/.well-known/auth`:
  - Handles non-general messages and listens for certificates.
  - Calls the `onCertificatesReceived` callback (if provided) when certificates are received.
- For general messages:
  - Sets up a listener for peer-to-peer general messages.
  - Overrides response methods (`send`, `json`, etc.) for custom handling.
- Returns a 401 error if mutual authentication fails.

### Parameters:

```ts
public async handleIncomingRequest(req: AuthRequest, res: Response, next: NextFunction, onCertificatesReceived?: (senderPublicKey: string, certs: VerifiableCertificate[], req: AuthRequest, res: Response, next: NextFunction) => void | Promise<void>): Promise<void>
```

See also: [AuthRequest](#interface-authrequest)

Argument Details

- **req**
  - The incoming HTTP request.
- **res**
  - The HTTP response.
- **next**
  - The Express `next` middleware function.
- **onCertificatesReceived**
  - Optional callback invoked when certificates are received.

#### Method onData

Stores the callback bound by a Peer

```ts
async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void>
```

#### Method send

Sends an AuthMessage to the connected Peer.
This method uses an Express response object to deliver the message to the specified Peer.

### Parameters:

```ts
async send(message: AuthMessage): Promise<void>
```

Returns

A promise that resolves once the message has been sent successfully.

Argument Details

- **message**
  - The authenticated message to send.

### Returns:

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Functions

|                                                                      |
| -------------------------------------------------------------------- |
| [convertValueToArray](#function-convertvaluetoarray)                 |
| [createAuthMiddleware](#function-createauthmiddleware)               |
| [getLogMethod](#function-getlogmethod)                               |
| [isLogLevelEnabled](#function-isloglevelenabled)                     |
| [makeDebugLogger](#function-makedebuglogger)                         |
| [writeBodyToWriter](#function-writebodytowriter)                     |
| [writeHeaderPair](#function-writeheaderpair)                         |
| [writeRequestHeadersToWriter](#function-writerequestheaderstowriter) |
| [writeUrlToWriter](#function-writeurltowriter)                       |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: convertValueToArray

Helper: Convert values passed to res.send(...) into byte arrays

```ts
export function convertValueToArray(val: unknown, responseHeaders: Record<string, string>): number[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: createAuthMiddleware

Creates an Express middleware that handles authentication via BSV-SDK.

```ts
export function createAuthMiddleware(
  options: AuthMiddlewareOptions
): (req: AuthRequest, res: Response, next: NextFunction) => void
```

See also: [AuthMiddlewareOptions](#interface-authmiddlewareoptions), [AuthRequest](#interface-authrequest)

<details>

<summary>Function createAuthMiddleware Details</summary>

Returns

Express middleware

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: getLogMethod

Retrieves the appropriate logging method from the logger,
falling back to `log` if not found.

Uses an explicit switch to avoid dynamic property access on a user-influenced
key, which prevents CodeQL js/unvalidated-dynamic-method-call alerts.

```ts
export function getLogMethod(logger: typeof console, level: LogLevel): (...args: any[]) => void
```

See also: [LogLevel](#type-loglevel)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: isLogLevelEnabled

Helper to determine if a given message-level log should be output
based on the configured log level.

```ts
export function isLogLevelEnabled(configuredLevel: LogLevel, messageLevel: LogLevel): boolean
```

See also: [LogLevel](#type-loglevel)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: makeDebugLogger

Returns a no-op or a bound debug logger depending on config.

```ts
export function makeDebugLogger(
  logger?: typeof console,
  logLevel?: LogLevel
): (msg: string, data: any) => void
```

See also: [LogLevel](#type-loglevel)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: writeBodyToWriter

Helper: Write body to writer

```ts
export function writeBodyToWriter(
  req: Request,
  writer: Utils.Writer,
  logger?: typeof console,
  logLevel?: LogLevel
): void
```

See also: [LogLevel](#type-loglevel)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: writeHeaderPair

Write a header pair (key + value) to the binary writer.

```ts
export function writeHeaderPair(writer: Utils.Writer, key: string, value: string): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: writeRequestHeadersToWriter

Collect and write signed request headers to the binary writer.

```ts
export function writeRequestHeadersToWriter(req: Request, writer: Utils.Writer): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

### Function: writeUrlToWriter

Write the URL pathname and search components to the binary writer.

```ts
export function writeUrlToWriter(parsedUrl: URL, writer: Utils.Writer): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Types

### Type: LogLevel

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---
