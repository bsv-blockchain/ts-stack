# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

## Interfaces

### Interface: AuthMiddlewareOptions

```ts
export interface AuthMiddlewareOptions {
    wallet: WalletInterface;
    sessionManager?: SessionManager;
    allowUnauthenticated?: boolean;
    certificatesToRequest?: RequestedCertificateSet;
    onCertificatesReceived?: (senderPublicKey: string, certs: VerifiableCertificate[], req: Request, res: Response, next: NextFunction) => void;
    logger?: typeof console;
    logLevel?: "debug" | "info" | "warn" | "error";
}
```

<details>

<summary>Interface AuthMiddlewareOptions Details</summary>

#### Property logLevel

Optional logging level. Defaults to no logging if not provided.
'debug' | 'info' | 'warn' | 'error'

- debug: Logs *everything*, including low-level details of the auth process.
- info: Logs general informational messages about normal operation.
- warn: Logs potential issues but not necessarily errors.
- error: Logs only critical issues and errors.

```ts
logLevel?: "debug" | "info" | "warn" | "error"
```

#### Property logger

Optional logger (e.g., console). If not provided, logging is disabled.

```ts
logger?: typeof console
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
## Classes

### Class: ExpressTransport

Transport implementation for Express.

```ts
export class ExpressTransport implements Transport {
    peer?: Peer;
    allowAuthenticated: boolean;
    openNonGeneralHandles: Record<string, Response[]> = {};
    openGeneralHandles: Record<string, Response> = {};
    openNextHandlers: Record<string, NextFunction> = {};
    constructor(allowUnauthenticated: boolean = false, logger?: typeof console, logLevel?: "debug" | "info" | "warn" | "error") 
    setPeer(peer: Peer): void 
    async send(message: AuthMessage): Promise<void> 
    async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> 
    public handleIncomingRequest(req: Request, res: Response, next: NextFunction, onCertificatesReceived?: (senderPublicKey: string, certs: VerifiableCertificate[], req: Request, res: Response, next: NextFunction) => void): void 
}
```

<details>

<summary>Class ExpressTransport Details</summary>

#### Constructor

Constructs a new ExpressTransport instance.

```ts
constructor(allowUnauthenticated: boolean = false, logger?: typeof console, logLevel?: "debug" | "info" | "warn" | "error") 
```

Argument Details

+ **allowUnauthenticated**
  + Whether to allow unauthenticated requests passed the auth middleware. 
If `true`, requests without authentication will be permitted, and `req.auth.identityKey` 
will be set to `"unknown"`. If `false`, unauthenticated requests will result in a `401 Unauthorized` response.
+ **logger**
  + Logger to use (e.g., console). If omitted, logging is disabled.
+ **logLevel**
  + Log level. If omitted, no logs are output.

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
public handleIncomingRequest(req: Request, res: Response, next: NextFunction, onCertificatesReceived?: (senderPublicKey: string, certs: VerifiableCertificate[], req: Request, res: Response, next: NextFunction) => void): void 
```

Argument Details

+ **req**
  + The incoming HTTP request.
+ **res**
  + The HTTP response.
+ **next**
  + The Express `next` middleware function.
+ **onCertificatesReceived**
  + Optional callback invoked when certificates are received.

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

+ **message**
  + The authenticated message to send.

### Returns:

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
## Functions

### Function: createAuthMiddleware

Creates an Express middleware that handles authentication via BSV-SDK.

```ts
export function createAuthMiddleware(options: AuthMiddlewareOptions) 
```

See also: [AuthMiddlewareOptions](#interface-authmiddlewareoptions)

<details>

<summary>Function createAuthMiddleware Details</summary>

Returns

Express middleware

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions)

---
