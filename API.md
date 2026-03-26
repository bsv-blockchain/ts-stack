# API Reference

---

## Table of contents

- [High-level facades](#high-level-facades)
  - [WalletRelayService](#walletrelayservice)
  - [WalletPairingSession](#walletpairingsession)
- [React](#react)
  - [QRPairingCode](#qrpairingcode)
  - [useQRPairing](#useqrpairing)
- [Building blocks](#building-blocks)
  - [WebSocketRelay](#websocketrelay)
  - [QRSessionManager](#qrsessionmanager)
  - [WalletRequestHandler](#walletrequesthandler)
- [Shared utilities](#shared-utilities)
  - [parsePairingUri](#parsepairinguri)
  - [buildPairingUri](#buildpairinguri)
  - [encryptEnvelope](#encryptenvelope)
  - [decryptEnvelope](#decryptenvelope)
  - [bytesToBase64url / base64urlToBytes](#bytestobase64url--base64urltobytes)
- [Types](#types)

---

## High-level facades

### WalletRelayService

`import { WalletRelayService } from 'qr-lib'`

Express + WebSocket service that handles the full server-side pairing lifecycle. Registers REST routes and the `/ws` WebSocket endpoint automatically on construction.

#### Constructor

```ts
new WalletRelayService(options: WalletRelayServiceOptions)
```

| Option | Type | Description |
|--------|------|-------------|
| `app` | `Express` | Express application instance. REST routes are registered on it. |
| `server` | `http.Server` | HTTP server. The WebSocket upgrade handler is attached here. |
| `wallet` | `WalletLike` | Backend wallet used to encrypt/decrypt messages. Accepts `ProtoWallet` or `WalletClient`. |
| `relayUrl` | `string` | `ws://` or `wss://` base URL of this server. Embedded in the QR pairing URI so the mobile knows where to connect. |
| `origin` | `string` | `http://` or `https://` URL of the desktop frontend. Used as CORS origin and embedded in the pairing URI. |

#### Methods

**`createSession()`**

```ts
createSession(): Promise<{ sessionId: string; status: string; qrDataUrl: string; desktopToken: string }>
```

Creates a new pairing session, builds the `wallet://pair?…` URI, and generates a QR code data URL. Returns the session ID, its initial status (`'pending'`), the base64 QR image, and a `desktopToken`.

The `desktopToken` is a cryptographically random secret that must be passed as a `?token=` query parameter when the desktop opens its WebSocket connection (`role=desktop`). Keep it server-side — do not embed it in the QR code or share it with the mobile.

---

**`getSession(id)`**

```ts
getSession(id: string): { sessionId: string; status: string } | null
```

Returns the current status of a session, or `null` if the session does not exist. Status values: `'pending'` | `'connected'` | `'disconnected'` | `'expired'`.

---

**`sendRequest(sessionId, method, params)`**

```ts
sendRequest(sessionId: string, method: string, params: unknown): Promise<RpcResponse>
```

Encrypts an RPC call, sends it to the paired mobile wallet over WebSocket, and waits for the response. Rejects with an error after 30 seconds if no response arrives. Returns early with an error response if the session is not in `'connected'` state.

---

**`stop()`**

```ts
stop(): void
```

Stops the session GC timer and closes the WebSocket server. Call on process shutdown.

---

#### Registered routes

| Method | Path | Body | Response |
|--------|------|------|----------|
| `GET` | `/api/session` | — | `{ sessionId, status, qrDataUrl }` |
| `GET` | `/api/session/:id` | — | `{ sessionId, status }` |
| `POST` | `/api/request/:id` | `{ method: string, params: unknown }` | `RpcResponse` |

---

### WalletPairingSession

`import { WalletPairingSession } from 'qr-lib/client'`

Manages the full mobile-side WebSocket pairing lifecycle:

1. Connects to the relay as `role=mobile`
2. Encrypts and sends `pairing_approved`
3. Transitions to `connected` on the first successfully decrypted inbound message
4. Enforces replay protection (drops any message whose `seq` is not strictly greater than the last seen)
5. Dispatches inbound RPC requests through the registered handler, with an optional approval gate

#### Constructor

```ts
new WalletPairingSession(
  wallet: WalletLike,
  params: PairingParams,
  options?: WalletPairingSessionOptions
)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `wallet` | `WalletLike` | Mobile wallet. Used to fetch the identity key and to encrypt/decrypt all messages. |
| `params` | `PairingParams` | Parsed pairing parameters from `parsePairingUri()`. |
| `options` | `WalletPairingSessionOptions` | Optional configuration — see below. |

#### WalletPairingSessionOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `implementedMethods` | `Set<string>` | `undefined` | Methods your handler actually implements. Requests for any other method receive a `501` response without invoking `onApprovalRequired` or `onRequest`. If omitted, all methods are forwarded. |
| `autoApproveMethods` | `Set<string>` | `undefined` | Subset of `implementedMethods` that are executed without calling `onApprovalRequired`. Useful for read-only methods like `getPublicKey`. |
| `onApprovalRequired` | `(method, params) => Promise<boolean>` | `undefined` | Called for every implemented method not in `autoApproveMethods`. Return `true` to approve, `false` to send a `4001 User Rejected` response. If omitted, all implemented methods are auto-approved. |
| `walletMeta` | `Record<string, unknown>` | `{}` | Additional metadata sent inside the `pairing_approved` payload. Useful for identifying the wallet on the desktop side (e.g. `{ name, version }`). |

#### Methods

**`connect()`**

```ts
connect(): Promise<void>
```

Opens the WebSocket connection to the relay and sends `pairing_approved`. Seq tracking starts from 0. Use for fresh pairings where no prior session state exists.

---

**`reconnect(lastSeq)`**

```ts
reconnect(lastSeq: number): Promise<void>
```

Re-opens the WebSocket connection using a stored seq baseline. Replay protection resumes from `lastSeq` — any inbound message with `seq ≤ lastSeq` is dropped. Use this after a network drop when the session is still valid on the backend.

```ts
const lastSeq = await SecureStore.getItemAsync(`lastseq_${topic}`)
await session.reconnect(Number(lastSeq ?? 0))
```

---

**`disconnect()`**

```ts
disconnect(): void
```

Closes the WebSocket connection.

---

**`onRequest(handler)`**

```ts
onRequest(handler: (method: string, params: unknown) => Promise<unknown>): this
```

Registers the function that executes approved RPC methods. Called after the approval gate passes. Should throw on failure — the error message is returned to the desktop as a `500` response. Returns `this` for chaining.

---

**`on(event, handler)`**

```ts
on(event: 'connected',    handler: () => void): this
on(event: 'disconnected', handler: () => void): this
on(event: 'error',        handler: (msg: string) => void): this
```

Registers an event listener. Multiple listeners per event are supported. Returns `this` for chaining.

| Event | Fires when |
|-------|-----------|
| `connected` | The first successfully decrypted message is received (session is live) |
| `disconnected` | The WebSocket closes after a successful connection |
| `error` | A connection error occurs, or the relay could not be reached |

#### `status` property

```ts
get status(): PairingSessionStatus
```

Current state: `'idle'` | `'connecting'` | `'connected'` | `'disconnected'` | `'error'`

---

## React

`import { QRPairingCode, useQRPairing } from 'qr-lib/react'`

Peer dependency: `react >= 17`

---

### QRPairingCode

A tappable QR code component for web. Clicking/tapping opens the `wallet://pair?…` URI as a deeplink, launching the BSV wallet app directly on mobile browsers.

#### Props

```ts
type QRPairingCodeProps = {
  qrDataUrl:   string
  pairingUri:  string
  onPress?:    (pairingUri: string) => void
  imageProps?: React.ImgHTMLAttributes<HTMLImageElement>
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onClick'>
```

| Prop | Type | Description |
|------|------|-------------|
| `qrDataUrl` | `string` | Base64 data URL of the QR image. Returned by `WalletRelayService.createSession()`. |
| `pairingUri` | `string` | The `wallet://pair?…` URI. Used as the deeplink target when tapped. |
| `onPress` | `(uri: string) => void` | Override the deeplink action. Defaults to `window.location.href = pairingUri`. Pass `(uri) => Linking.openURL(uri)` in React Native. |
| `imageProps` | `React.ImgHTMLAttributes<HTMLImageElement>` | Props forwarded to the inner `<img>` (e.g. `alt`, `style`, `className`). Ignored when `children` is provided. |
| `children` | `ReactNode` | Replace the default `<img>` entirely. Use this to plug in a custom QR renderer. |
| `...divProps` | `React.HTMLAttributes<HTMLDivElement>` | Any other props (`className`, `style`, `data-*`, `aria-*`, etc.) are spread onto the wrapper `<div>`. |

The wrapper always has `role="button"` and `tabIndex={0}`. Enter and Space keys trigger the same action as a click.

#### Examples

```tsx
// Minimal
<QRPairingCode qrDataUrl={dataUrl} pairingUri={uri} />

// Styled
<QRPairingCode
  qrDataUrl={dataUrl}
  pairingUri={uri}
  className="rounded-xl shadow-lg"
  imageProps={{ className: 'w-64 h-64', alt: 'Scan to connect wallet' }}
/>

// Custom renderer
<QRPairingCode qrDataUrl={dataUrl} pairingUri={uri}>
  <SvgQRCode value={uri} size={256} />
</QRPairingCode>

// Custom handler (e.g. analytics before navigating)
<QRPairingCode
  qrDataUrl={dataUrl}
  pairingUri={uri}
  onPress={uri => { track('qr_tapped'); window.location.href = uri }}
/>
```

---

### useQRPairing

Cross-platform hook that returns an `open()` function to trigger the wallet deeplink. Use this directly in React Native where `<QRPairingCode>` is not suitable.

#### Signature

```ts
function useQRPairing(
  pairingUri: string,
  options?: { openUrl?: (uri: string) => void }
): { open: () => void; pairingUri: string }
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `pairingUri` | `string` | The `wallet://pair?…` URI to open. |
| `options.openUrl` | `(uri: string) => void` | Override URL-opening strategy. Required in React Native — pass `Linking.openURL`. Defaults to `window.location.href` on web. |

#### Return value

| Property | Type | Description |
|----------|------|-------------|
| `open` | `() => void` | Call to open the deeplink. Stable reference (memoised with `useCallback`). |
| `pairingUri` | `string` | The pairing URI passed in — convenient for passing to a QR renderer. |

#### Example (React Native)

```tsx
import { Linking } from 'react-native'
import { useQRPairing } from 'qr-lib/react'

function PairingScreen({ pairingUri, qrDataUrl }) {
  const { open } = useQRPairing(pairingUri, { openUrl: Linking.openURL })

  return (
    <TouchableOpacity onPress={open} accessibilityRole="button">
      <Image source={{ uri: qrDataUrl }} style={{ width: 256, height: 256 }} />
    </TouchableOpacity>
  )
}
```

---

## Building blocks

These classes are exported from `qr-lib` (server entry) and can be composed freely for advanced use cases.

---

### WebSocketRelay

`import { WebSocketRelay } from 'qr-lib'`

Topic-keyed WebSocket bridge. Mounts at `/ws`. Connections use `?topic=<sessionId>&role=desktop|mobile`.

- Messages from each side are forwarded to the other (or buffered for up to 60 s if the other side is not yet connected)
- Buffer cap: 50 messages per topic
- Heartbeat: pings every 30 s, terminates non-responsive sockets
- Max payload: 64 KiB per message

#### Constructor

```ts
new WebSocketRelay(server: http.Server, options?: { allowedOrigin?: string })
```

| Option | Type | Description |
|--------|------|-------------|
| `allowedOrigin` | `string` | If set, incoming WebSocket connections that include an `Origin` header must match this value exactly or the connection is rejected with close code `1008`. Browser clients always send `Origin` and cannot spoof it. Native clients (React Native, server-to-server) omit the header and are exempt. |

#### Methods

**`onIncoming(handler)`**

```ts
onIncoming(handler: (topic: string, envelope: WireEnvelope, role: 'desktop' | 'mobile') => void): void
```

Called for every inbound message from either side. The relay forwards the message to the other side *before* invoking this handler.

---

**`onValidateTopic(validator)`**

```ts
onValidateTopic(validator: (topic: string) => boolean): void
```

Called on each new WebSocket connection. Return `false` to reject the connection with close code `1008`.

---

**`sendToMobile(topic, envelope)`**

```ts
sendToMobile(topic: string, envelope: WireEnvelope): void
```

Sends an envelope to the mobile socket for the given topic. Buffers if the mobile is not connected.

---

**`sendToDesktop(topic, envelope)`**

```ts
sendToDesktop(topic: string, envelope: WireEnvelope): void
```

Sends an envelope to the desktop socket for the given topic. Buffers if the desktop is not connected.

---

**`onValidateDesktopToken(validator)`**

```ts
onValidateDesktopToken(validator: (topic: string, token: string | null) => boolean): void
```

Called for every new `role=desktop` connection. Receives the topic and the `token` query parameter (`null` if absent). Return `false` to reject the connection with close code `1008`. Used by `WalletRelayService` to enforce the desktop token generated in `createSession()`.

---

**`onDisconnect(handler)`**

```ts
onDisconnect(handler: (topic: string, role: 'desktop' | 'mobile') => void): void
```

Called when any WebSocket socket closes. Use this to react to mobile disconnects — for example, to immediately reject in-flight RPC requests rather than waiting for the 30-second timeout.

---

**`removeTopic(topic)`**

```ts
removeTopic(topic: string): void
```

Removes all state for a topic. Call when the corresponding session is deleted.

---

**`close()`**

```ts
close(): void
```

Stops the heartbeat timer and closes the WebSocket server.

---

### QRSessionManager

`import { QRSessionManager } from 'qr-lib'`

In-memory session store with automatic garbage collection.

- Session IDs are 32-byte random base64url strings, also used as WS topic and BSV wallet keyID
- Pairing window: 120 s (pending sessions become `expired` after this)
- Session TTL: 30 days (sessions are GC'd from memory after this)
- GC runs every 10 minutes

#### Constructor

```ts
new QRSessionManager()
```

#### Methods

**`createSession()`**

```ts
createSession(): Session
```

Creates and stores a new session with status `'pending'`. Returns the full `Session` object.

---

**`getSession(id)`**

```ts
getSession(id: string): Session | null
```

Returns the session, or `null` if not found. Lazily marks `pending` sessions as `expired` if their 120 s pairing window has elapsed.

---

**`setStatus(id, status)`**

```ts
setStatus(id: string, status: SessionStatus): void
```

Updates the session status. Valid values: `'pending'` | `'connected'` | `'disconnected'` | `'expired'`.

---

**`setMobileIdentityKey(id, key)`**

```ts
setMobileIdentityKey(id: string, key: string): void
```

Stores the mobile's identity public key on the session. Called once on `pairing_approved`.

---

**`generateQRCode(uri)`**

```ts
generateQRCode(uri: string): Promise<string>
```

Generates a base64 PNG data URL for the given URI. Requires the `qrcode` peer dependency. The `qrcode` module is loaded via dynamic import so it remains optional for non-server bundles.

---

**`onSessionExpired(cb)`**

```ts
onSessionExpired(cb: (id: string) => void): void
```

Registers a callback invoked when a session is removed by the GC. Use this to clean up associated relay topics.

---

**`stop()`**

```ts
stop(): void
```

Clears the GC interval. Call on process shutdown.

---

### WalletRequestHandler

`import { WalletRequestHandler } from 'qr-lib'`

Pure JSON-RPC message factory. No I/O — safe to use in any environment.

Maintains an internal incrementing `seq` counter shared across all messages created by the same instance.

#### Constructor

```ts
new WalletRequestHandler()
```

#### Methods

**`createRequest(method, params)`**

```ts
createRequest(method: string, params: unknown): RpcRequest
```

Returns a new `RpcRequest` with a random UUID `id` and the next `seq` value.

---

**`createProtocolMessage(method, params)`**

```ts
createProtocolMessage(method: string, params: unknown): RpcRequest
```

Same shape as `createRequest`. Intended for protocol-level messages (`pairing_ack`, `session_revoke`, etc.) to keep them semantically distinct from application RPC calls.

---

**`parseMessage(raw)`**

```ts
parseMessage(raw: string): RpcRequest | RpcResponse
```

Parses a JSON string into an `RpcRequest` or `RpcResponse`. No validation beyond `JSON.parse`.

---

**`isResponse(msg)`**

```ts
isResponse(msg: RpcRequest | RpcResponse): msg is RpcResponse
```

Type guard: returns `true` if the message has a `result` or `error` field.

---

**`errorResponse(id, seq, code, message)`**

```ts
errorResponse(id: string, seq: number, code: number, message: string): RpcResponse
```

Constructs an error `RpcResponse` directly.

---

## Shared utilities

Available from both `qr-lib` and `qr-lib/client`.

---

### parsePairingUri

```ts
function parsePairingUri(raw: string): ParseResult
```

Parses and validates a `wallet://pair?…` QR code URI. Returns `{ params, error: null }` on success or `{ params: null, error: string }` on failure.

Validations performed:

| Check | Detail |
|-------|--------|
| Protocol | Must be `wallet:` |
| Required fields | `topic`, `relay`, `backendIdentityKey`, `protocolID`, `keyID`, `origin`, `expiry` all present |
| Expiry | `expiry` must be in the future |
| Relay scheme | Must be `ws://` or `wss://` |
| Origin scheme | Must be `http://` or `https://` |
| M1 host check | For `wss://` relays, hostname must match origin hostname (exempts `ws://` local dev) |
| Identity key format | Must match compressed secp256k1 (`/^0[23][0-9a-fA-F]{64}$/`) |
| protocolID | Must be valid JSON of shape `[number, string]` |
| keyID | Must equal `topic` |

---

### buildPairingUri

```ts
function buildPairingUri(params: {
  sessionId:        string
  relayURL:         string
  backendIdentityKey: string
  protocolID:       string   // JSON.stringify(PROTOCOL_ID)
  origin:           string
  pairingTtlMs?:    number   // default: 120_000 (2 minutes)
}): string
```

Builds a `wallet://pair?…` URI from session parameters. The `sessionId` is used as both `topic` and `keyID`. Expiry is computed as `now + pairingTtlMs`.

---

### encryptEnvelope

```ts
function encryptEnvelope(
  wallet:  WalletLike,
  params:  CryptoParams,
  payload: string
): Promise<string>
```

Encrypts a plaintext string using `wallet.encrypt()` and returns a base64url ciphertext string. Uses `TextEncoder` — no `Buffer` dependency, works in Node.js, browsers, and React Native.

**`CryptoParams`**

| Field | Type | Description |
|-------|------|-------------|
| `protocolID` | `WalletProtocol` | BSV SDK protocol ID tuple, e.g. `[0, 'mobile wallet session']` |
| `keyID` | `string` | Session ID — makes the derived key unique per session |
| `counterparty` | `string` | Compressed public key of the other party |

---

### decryptEnvelope

```ts
function decryptEnvelope(
  wallet:         WalletLike,
  params:         CryptoParams,
  ciphertextB64:  string
): Promise<string>
```

Decrypts a base64url ciphertext string produced by `encryptEnvelope`. Throws if decryption fails (wrong key, tampered ciphertext, wrong `keyID`). Uses `TextDecoder` — no `Buffer` dependency.

---

### bytesToBase64url / base64urlToBytes

```ts
function bytesToBase64url(bytes: number[]): string
function base64urlToBytes(str: string): number[]
```

Converts between `number[]` byte arrays and base64url strings using `@bsv/sdk`'s `Utils.toBase64` / `Utils.toArray`. Safe in Node.js, browsers, and React Native — no `Buffer` global required.

---

## Types

All types are exported from both `qr-lib` and `qr-lib/client`.

---

### WalletLike

```ts
type WalletLike = Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>
```

Minimal wallet interface required by the library. Satisfied by `ProtoWallet` and `WalletClient` from `@bsv/sdk`, as well as any object that implements the three methods.

---

### WireEnvelope

```ts
interface WireEnvelope {
  topic:              string   // Session ID — relay routing key
  ciphertext:         string   // base64url output of wallet.encrypt
  mobileIdentityKey?: string   // Only present on pairing_approved (bootstrap)
}
```

---

### RpcRequest

```ts
interface RpcRequest {
  id:     string   // UUID
  seq:    number   // Monotonically increasing, used for replay protection
  method: string
  params: unknown
}
```

---

### RpcResponse

```ts
interface RpcResponse {
  id:      string
  seq:     number
  result?: unknown
  error?:  { code: number; message: string }
}
```

---

### Session

```ts
interface Session {
  id:                string          // Also: WS topic and BSV keyID
  status:            SessionStatus
  createdAt:         number          // Unix ms
  expiresAt:         number          // Unix ms (30 days after creation)
  desktopToken:      string          // Random secret required for role=desktop WS connections
  mobileIdentityKey?: string         // Set once on pairing_approved
}

type SessionStatus = 'pending' | 'connected' | 'disconnected' | 'expired'
```

---

### PairingParams

```ts
interface PairingParams {
  topic:              string   // Session ID
  relay:              string   // ws(s):// relay URL
  backendIdentityKey: string   // Compressed secp256k1 public key
  protocolID:         string   // JSON-encoded [number, string] tuple
  keyID:              string   // Always equals topic
  origin:             string   // http(s):// desktop frontend URL
  expiry:             string   // Unix seconds
}
```

---

### ParseResult

```ts
type ParseResult =
  | { params: PairingParams; error: null }
  | { params: null;          error: string }
```

---

### PROTOCOL_ID

```ts
const PROTOCOL_ID: WalletProtocol = [0, 'mobile wallet session']
```

The BSV wallet protocol ID used for all message encryption in this library. Pass this as `protocolID` when constructing `CryptoParams` manually.
