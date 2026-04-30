# API Reference

---

## Table of contents

- [High-level facades](#high-level-facades)
  - [WalletRelayService](#walletrelayservice)
  - [WalletRelayClient](#walletrelayclient)
  - [WalletPairingSession](#walletpairingsession)
- [React](#react)
  - [useWalletRelayClient](#usewalletrelayclient)
  - [WalletConnectionModal](#walletconnectionmodal)
  - [QRDisplay](#qrdisplay)
  - [QRPairingCode](#qrpairingcode)
  - [RequestLog](#requestlog)
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
  - [WalletRequest / WalletResponse / RequestLogEntry](#walletrequest--walletresponse--requestlogentry)

---

## High-level facades

### WalletRelayService

`import { WalletRelayService } from '@bsv/wallet-relay'`

Express + WebSocket service that handles the full server-side pairing lifecycle. Registers REST routes and the `/ws` WebSocket endpoint automatically on construction.

#### Constructor

```ts
new WalletRelayService(options: WalletRelayServiceOptions)
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `app` | `RouterLike` | No | — | Express-compatible app with `get` and `post` methods. REST routes are registered on it. Omit when using Next.js or another framework — call `createSession()`, `getSession()`, and `sendRequest()` from your own route handlers instead. Uses a structural duck-type to avoid nominal type conflicts in monorepos. |
| `server` | `http.Server` | **Yes** | — | HTTP server. The WebSocket upgrade handler is attached here. |
| `wallet` | `WalletLike` | **Yes** | — | Backend wallet for encrypting/decrypting messages. Use `ProtoWallet` with a stable private key: `new ProtoWallet(PrivateKey.fromHex(process.env.WALLET_PRIVATE_KEY!))`. The same key must be used across restarts — the mobile derives its ECDH shared secret from the backend identity key embedded in the QR code. |
| `relayUrl` | `string` | No | `process.env.RELAY_URL` → `ws://localhost:3000` | `ws://` or `wss://` base URL of this server. Returned by `GET /api/session/:id` so the mobile can resolve it after scanning the QR. Not embedded in the QR itself. |
| `origin` | `string` | No | `process.env.ORIGIN` → `http://localhost:5173` | `http://` or `https://` URL of the backend API root. Used for WebSocket origin validation and embedded in the QR pairing URI. The mobile calls `{origin}/api/session/{topic}` over HTTPS to resolve the relay URL — this is the trust anchor. In production this is your app domain. In local dev with a split Vite/Node setup, set this to the backend's LAN address so the mobile device can reach it (see `MOBILE_ORIGIN` in the quickstart). |
| `maxSessions` | `number` | No | unlimited | Maximum number of sessions held in memory at once. `GET /api/session` returns HTTP 429 when the limit is reached. |
| `schema` | `string` | No | `process.env.PAIRING_SCHEMA` → `'bsv-browser'` | Deep-link scheme used in the generated QR URI (without `://`). Defaults to `'bsv-browser'`. Set to your wallet's own scheme (e.g. `'bsv-browser'`, `'my-wallet'`) to target a specific app — the OS will open that app directly instead of showing a picker when multiple wallets are installed. The mobile app must register this scheme and pass it to `parsePairingUri` via `acceptedSchemas`. |
| `signQrCodes` | `boolean` | No | `true` | Sign the QR pairing URI with the backend wallet key. The mobile can verify the signature using `verifyPairingSignature` before connecting — this proves the QR fields have not been tampered with. Set to `false` only for backward compatibility with mobile apps that do not yet call `verifyPairingSignature`. |
| `onSessionConnected` | `(sessionId: string) => void` | No | — | Called when a mobile completes pairing and the session transitions to `'connected'`. |
| `onSessionDisconnected` | `(sessionId: string) => void` | No | — | Called when a connected mobile disconnects and the session transitions to `'disconnected'`. |

#### Methods

**`createSession()`**

```ts
createSession(): Promise<{
  sessionId:    string
  status:       string
  qrDataUrl:    string
  pairingUri:   string
  desktopToken: string
}>
```

Creates a new pairing session, builds the `wallet://pair?…` URI, and generates a QR code data URL. Returns the session ID, its initial status (`'pending'`), the base64 QR image, the raw pairing URI (pass this to `QRPairingCode` or `useQRPairing`), and a `desktopToken`.

The `desktopToken` is a cryptographically random secret that must be passed as a `?token=` query parameter when the desktop opens its WebSocket connection (`role=desktop`). Keep it server-side — do not embed it in the QR code or share it with the mobile.

---

**`getSession(id)`**

```ts
getSession(id: string): { sessionId: string; status: string; relay: string } | null
```

Returns the current status and relay URL of a session, or `null` if the session does not exist. Status values: `'pending'` | `'connected'` | `'disconnected'` | `'expired'`.

The `relay` field is the `ws://` or `wss://` address the mobile should connect to. This is how the mobile resolves the relay without it being embedded in the QR — it calls this endpoint over HTTPS and reads `relay` from the response.

---

**`sendRequest(sessionId, method, params)`**

```ts
sendRequest(sessionId: string, method: string, params: unknown, desktopToken?: string): Promise<RpcResponse>
```

Encrypts an RPC call, sends it to the paired mobile wallet over WebSocket, and waits for the response. Rejects with an error after 30 seconds if no response arrives. Throws if the session is not in `'connected'` state or if `desktopToken` does not match the token issued at session creation.

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
| `GET` | `/api/session` | — | `{ sessionId, status, qrDataUrl, pairingUri, desktopToken }` |
| `GET` | `/api/session/:id` | — | `{ sessionId, status, relay }` |
| `POST` | `/api/request/:id` | `{ method: string, params: unknown }` | `RpcResponse` |

`GET /api/session/:id` is called by the mobile app after scanning the QR to resolve the relay WebSocket URL. The mobile trusts this response because it is served over HTTPS from the origin embedded in the QR.

---

### WalletRelayClient

`import { WalletRelayClient } from '@bsv/wallet-relay/client'`

Frontend counterpart to `WalletRelayService`. Manages session creation, status polling, and RPC requests against the relay HTTP API. Framework-agnostic — use directly with callbacks, or via [`useWalletRelayClient`](#usewalletrelayclient) for React state integration.

```ts
const client = new WalletRelayClient({
  onSessionChange: (s) => render(s),
  onError:         (msg) => showError(msg),
})
await client.createSession()
const res = await client.sendRequest('getPublicKey', { identityKey: true })
client.destroy()
```

#### Constructor

```ts
new WalletRelayClient(options?: WalletRelayClientOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiUrl` | `string` | `'/api'` | Base URL for the relay HTTP API. Can be the bare host (`'https://api.example.com'`) or include the `/api` suffix — `/api` is appended automatically if missing. |
| `pollInterval` | `number` | `3000` | Session status polling interval in ms while waiting for the mobile to connect. |
| `connectedPollInterval` | `number` | `10000` | Session status polling interval in ms once the mobile is connected. Reduced frequency since the session is stable — polling continues to detect reconnects after a mobile disconnect. |
| `persistSession` | `boolean` | `true` | Persist the active session to `sessionStorage` so a page refresh resumes the existing session. Disable if you want every mount to start fresh. |
| `sessionStorageKey` | `string` | `'wallet-relay-session:<apiUrl>'` | Key used in `sessionStorage`. Namespaced by `apiUrl` by default — override if you need multiple relay instances on the same page. |
| `sessionStorageTtl` | `number` | `86400000` (24 h) | Max age (ms) of a persisted session before it is discarded without a network request. The server is still the authority — an expired server session is detected on the first poll and cleared regardless. |
| `onSessionChange` | `(session: SessionInfo) => void` | — | Called on session creation and on every poll that returns a new value. The `qrDataUrl` and `pairingUri` from the initial creation are merged into every subsequent poll response, so they remain available throughout the session lifecycle. |
| `onLogChange` | `(log: RequestLogEntry[]) => void` | — | Called whenever the request log changes — when a request is added or a response arrives. |
| `onError` | `(error: string) => void` | — | Called when `createSession()` fails. |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `session` | `SessionInfo \| null` | Current session state, or `null` before `createSession()` is called. |
| `log` | `RequestLogEntry[]` | Request log, newest first. |
| `error` | `string \| null` | Error from the last failed `createSession()`, or `null`. |
| `wallet` | `Pick<WalletInterface, WalletMethodName> \| null` | `WalletInterface`-compatible proxy when `session.status === 'connected'`, otherwise `null`. Each method forwards to `sendRequest` and throws on error — use as a drop-in replacement for `WalletClient` at existing call sites. See [wallet proxy](#wallet-proxy). |

#### Methods

**`resumeSession()`**

```ts
resumeSession(): Promise<SessionInfo | null>
```

Attempts to resume a previously persisted session from `sessionStorage`. Verifies the session is still alive on the server and restarts polling. Returns the resumed `SessionInfo`, or `null` if there is nothing to resume or the session has expired on the server (in which case storage is cleared).

Use before `createSession()` when you want page refreshes to survive:

```ts
const session = await client.resumeSession() ?? await client.createSession()
```

When using `useWalletRelayClient` with `autoCreate: true` (the default), `resumeSession` is called automatically on mount before falling back to `createSession`.

---

**`createSession()`**

```ts
createSession(): Promise<SessionInfo>
```

Creates a new backend session and starts polling for status changes. Any previously running poll is stopped first and any persisted session is cleared. Resolves with the new `SessionInfo` (including `qrDataUrl` and `pairingUri`). Throws on HTTP or network failure.

---

**`sendRequest(method, params?)`**

```ts
sendRequest(method: string, params?: unknown): Promise<WalletResponse>
```

Sends an RPC request to the paired mobile wallet. Adds a pending entry to the log immediately and resolves it when the response arrives.

Throws a [`WalletRelayError`](#walletrelayerror) on failure — catch it and check `.code` to distinguish error types:

```ts
import { WalletRelayError } from '@bsv/qr-lib/client'

try {
  const res = await client.sendRequest('getPublicKey', { identityKey: true })
  console.log(res.result)
} catch (err) {
  if (err instanceof WalletRelayError) {
    switch (err.code) {
      case 'SESSION_NOT_CONNECTED': // no active session or session not paired yet
      case 'REQUEST_TIMEOUT':       // mobile did not respond within 30 s
      case 'SESSION_DISCONNECTED':  // mobile dropped while the request was in-flight
      case 'INVALID_TOKEN':         // desktopToken mismatch — likely a config issue
      case 'NETWORK_ERROR':         // fetch failed or unexpected HTTP error
    }
  }
}
```

---

**`destroy()`**

```ts
destroy(): void
```

Stops the polling interval. Call on component unmount or teardown.

---

#### WalletRelayError

```ts
import { WalletRelayError, WalletRelayErrorCode } from '@bsv/qr-lib/client'
```

Typed error thrown by `sendRequest()`. Extends `Error` with a `code` discriminant.

```ts
class WalletRelayError extends Error {
  readonly code: WalletRelayErrorCode
}

type WalletRelayErrorCode =
  | 'SESSION_NOT_CONNECTED'  // no active session or session not yet in connected state
  | 'REQUEST_TIMEOUT'        // mobile did not respond within 30 s
  | 'SESSION_DISCONNECTED'   // mobile dropped while the request was in-flight
  | 'INVALID_TOKEN'          // desktopToken mismatch — likely a client config issue
  | 'NETWORK_ERROR'          // fetch failed or unexpected HTTP status
```

Use `err instanceof WalletRelayError` to type-narrow, then `err.code` to branch on the failure mode.

---

#### Wallet proxy

`WalletRelayClient.wallet` returns a `Pick<WalletInterface, WalletMethodName>` proxy built from the full list of relay-supported methods. Each method has the exact same signature as `WalletClient` — params pass through unchanged and the return value is the unwrapped result.

This means you can swap `WalletClient` for the relay proxy at your existing wallet context without touching any call sites:

```ts
// Before (local WalletClient):
const { txid } = await wallet.createAction({ description: 'Pay invoice', outputs: [...] })

// After (mobile relay proxy — identical):
const { txid } = await wallet.createAction({ description: 'Pay invoice', outputs: [...] })
```

Errors throw as normal `Error` objects with a `.code` property matching the mobile wallet's error code.

The proxy is `null` when the session is not connected and is lazily constructed on first access. Supported methods: `getPublicKey`, `listOutputs`, `createAction`, `signAction`, `createSignature`, `verifySignature`, `listActions`, `internalizeAction`, `acquireCertificate`, `relinquishCertificate`, `listCertificates`, `revealCounterpartyKeyLinkage`, `createHmac`, `verifyHmac`, `encrypt`, `decrypt`.

---

### WalletPairingSession

`import { WalletPairingSession } from '@bsv/wallet-relay/client'`

**This API is for mobile wallet developers.** If you are building a web app that accepts mobile wallet connections, you only need the backend (`WalletRelayService`) and the frontend template — you do not use `WalletPairingSession` directly.

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
| `implementedMethods` | `Set<string>` | `DEFAULT_IMPLEMENTED_METHODS` | Methods your handler actually implements. Requests for any other method receive a `501` response without invoking `onApprovalRequired` or `onRequest`. The default covers the full BSV Browser method set: `getPublicKey`, `listOutputs`, `listCertificates`, `createAction`, `signAction`, `createSignature`, `verifySignature`, `listActions`, `internalizeAction`, `acquireCertificate`, `relinquishCertificate`, `revealCounterpartyKeyLinkage`, `createHmac`, `verifyHmac`, `encrypt`, `decrypt`. |
| `autoApproveMethods` | `Set<string>` | `DEFAULT_AUTO_APPROVE_METHODS` | Subset of `implementedMethods` executed without calling `onApprovalRequired`. Defaults to `{ 'getPublicKey' }`. |
| `onApprovalRequired` | `(method, params) => Promise<boolean>` | `undefined` | Called for every implemented method not in `autoApproveMethods`. Return `true` to approve, `false` to send a `4001 User Rejected` response. If omitted, all implemented methods are auto-approved. |
| `walletMeta` | `Record<string, unknown>` | `{}` | Additional metadata sent inside the `pairing_approved` payload. Useful for identifying the wallet on the desktop side (e.g. `{ name, version }`). |

`DEFAULT_IMPLEMENTED_METHODS` and `DEFAULT_AUTO_APPROVE_METHODS` are exported from `@bsv/wallet-relay/client` so you can reference or extend them:

```ts
import { DEFAULT_IMPLEMENTED_METHODS, DEFAULT_AUTO_APPROVE_METHODS } from '@bsv/wallet-relay/client'

const session = new WalletPairingSession(wallet, params, {
  implementedMethods: new Set([...DEFAULT_IMPLEMENTED_METHODS, 'myCustomMethod']),
})
```

#### Methods

**`resolveRelay()`**

```ts
resolveRelay(): Promise<string>
```

Fetches the relay WebSocket URL from the origin server. **Must be called before `connect()` or `reconnect()`** — both will throw if `resolveRelay()` has not been called first.

Makes a `GET` request to `{params.origin}/api/session/{params.topic}` over HTTPS and reads the `relay` field from the response. The origin's TLS certificate is the trust anchor — the relay itself may be on any domain.

Returns the resolved relay URL so the app can display it for user inspection before connecting.

```ts
// Always show params.origin to the user before calling resolveRelay()
// so they can confirm which service they are connecting to.
const relay = await session.resolveRelay()
await session.connect()
```

Throws if the origin server returns a non-2xx status or does not include a `relay` field.

---

**`connect()`**

```ts
connect(): Promise<void>
```

Opens the WebSocket connection to the relay and sends `pairing_approved`. Seq tracking starts from 0. Use for fresh pairings where no prior session state exists.

Requires `resolveRelay()` to have been called first.

---

**`reconnect(lastSeq)`**

```ts
reconnect(lastSeq: number): Promise<void>
```

Re-opens the WebSocket connection using a stored seq baseline. Replay protection resumes from `lastSeq` — any inbound message with `seq ≤ lastSeq` is dropped. Use this after a network drop when the session is still valid on the backend.

Requires `resolveRelay()` to have been called first (call it again before `reconnect()` — it is a lightweight HTTP call).

```ts
const lastSeq = await SecureStore.getItemAsync(`lastseq_${topic}`)
await session.resolveRelay()
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

`import { ... } from '@bsv/wallet-relay/react'`

Peer dependency: `react >= 17`

---

### useWalletRelayClient

`import { useWalletRelayClient } from '@bsv/wallet-relay/react'`

React hook wrapping [`WalletRelayClient`](#walletrelayclient) with React state. The primary integration point for web apps — replaces the scaffolded `useWalletSession` template hook.

```tsx
const { session, log, error, createSession, cancelSession, sendRequest } = useWalletRelayClient()
```

#### Options

All options are optional.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiUrl` | `string` | `'/api'` | Backend base URL. `/api` is appended automatically if missing. |
| `pollInterval` | `number` | `3000` | Status polling interval in ms while waiting for mobile to connect. |
| `connectedPollInterval` | `number` | `10000` | Status polling interval in ms once connected. |
| `persistSession` | `boolean` | `true` | Persist session to `sessionStorage` for page-refresh survival. |
| `sessionStorageKey` | `string` | `'wallet-relay-session:<apiUrl>'` | Override the storage key. |
| `sessionStorageTtl` | `number` | `86400000` | Max age (ms) before a persisted session is discarded client-side. |
| `autoCreate` | `boolean` | `true` | When `true`, `resumeSession()` is tried on mount, falling back to `createSession()` if nothing to resume. Set to `false` to control timing manually. |

#### Return value

| Property | Type | Description |
|----------|------|-------------|
| `session` | `SessionInfo \| null` | Current session. `qrDataUrl` and `pairingUri` are present from creation and preserved through subsequent polls. |
| `log` | `RequestLogEntry[]` | Request history, newest first. |
| `error` | `string \| null` | Error from the last failed `createSession()`, or `null`. |
| `createSession` | `() => Promise<SessionInfo>` | Create a new session and restart polling. Safe to call multiple times — replaces the existing session. |
| `cancelSession` | `() => void` | Stop polling, destroy the client, and reset all state to `null`. Call on unmount when leaving a QR page to prevent the poll interval from running in the background. A subsequent `createSession()` starts fresh. |
| `sendRequest` | `(method: string, params?: unknown) => Promise<WalletResponse>` | Send an RPC call to the paired mobile. Throws if no session is active. |
| `wallet` | `Pick<WalletInterface, WalletMethodName> \| null` | Drop-in `WalletInterface` proxy when connected, `null` otherwise. See [wallet proxy](#wallet-proxy). |

React StrictMode safe — an internal ref guard prevents double session creation on the simulated unmount/remount cycle.

---

### WalletConnectionModal

`import { WalletConnectionModal } from '@bsv/wallet-relay/react'`

Unstyled wallet connection chooser with local wallet auto-detection.

Calls `WalletClient('auto').isAuthenticated()` on mount. If a local wallet is found, calls `onLocalWallet` immediately and renders nothing. If not found, renders a `<div>` containing an install link and a mobile QR button.

Returns `null` while detecting or once a local wallet is found.

#### Props

```ts
type WalletConnectionModalProps = {
  onLocalWallet:      (wallet: WalletClient) => void
  onMobileQR:         () => void
  installUrl?:        string
  installLabel?:      string
  mobileLabel?:       string
  installLinkProps?:  React.AnchorHTMLAttributes<HTMLAnchorElement>
  mobileButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>
} & React.HTMLAttributes<HTMLDivElement>
```

| Prop | Default | Description |
|------|---------|-------------|
| `onLocalWallet` | — | Called with the detected `WalletClient` when authentication succeeds. No UI is shown. |
| `onMobileQR` | — | Called when the user clicks the mobile QR button. |
| `installUrl` | `'https://desktop.bsvb.tech'` | `href` of the install link. |
| `installLabel` | `'Install BSV Wallet'` | Text for the install link. |
| `mobileLabel` | `'Connect via Mobile QR'` | Text for the mobile QR button. |
| `installLinkProps` | — | Props forwarded to the install `<a>`. |
| `mobileButtonProps` | — | Props forwarded to the mobile QR `<button>`. |
| `children` | — | Replace the default install link + QR button with custom content. |
| `...rootProps` | — | All other props spread onto the root `<div>`. Gets `data-wallet-detection="unavailable"`. |

#### Example

```tsx
<WalletConnectionModal
  onLocalWallet={(wallet) => setWallet(wallet)}
  onMobileQR={() => { setMode('mobile'); void createSession() }}
  className="fixed inset-0 flex items-center justify-center bg-black/50"
  installLinkProps={{ className: 'btn-primary block w-full' }}
  mobileButtonProps={{ className: 'btn-secondary block w-full' }}
/>
```

---

### QRDisplay

`import { QRDisplay } from '@bsv/wallet-relay/react'`

Unstyled QR display with status indicator and session refresh.

Shows a loading placeholder while `session` is null. Once a session exists it renders a [`QRPairingCode`](#qrpairingcode) (when `qrDataUrl` and `pairingUri` are available), a status label, and — when the session expires — a refresh button.

#### Props

```ts
type QRDisplayProps = {
  session:             SessionInfo | null
  onRefresh:           () => void
  loadingProps?:       React.HTMLAttributes<HTMLDivElement>
  statusProps?:        React.HTMLAttributes<HTMLSpanElement>
  refreshButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>
  qrProps?:            Omit<QRPairingCodeProps, 'qrDataUrl' | 'pairingUri'>
} & React.HTMLAttributes<HTMLDivElement>
```

| Prop | Description |
|------|-------------|
| `session` | Session from `useWalletRelayClient`. `null` renders the loading placeholder (`data-state="loading"`). |
| `onRefresh` | Called when the user clicks the refresh button (shown when `status === 'expired'` or `status === 'disconnected'`). Pass `createSession`. |
| `loadingProps` | Props on the loading placeholder `<div>`. |
| `statusProps` | Props on the status `<span>`. Gets `data-qr-status={status}`. |
| `refreshButtonProps` | Props on the refresh `<button>`. |
| `qrProps` | Props forwarded to the inner `QRPairingCode` (e.g. `imageProps`, `onPress`, `className`). |
| `children` | Rendered in place of `QRPairingCode` when `qrDataUrl` or `pairingUri` are absent. |
| `...rootProps` | All other props spread onto the root `<div>`. Gets `data-state={status}`. |

#### Example

```tsx
<QRDisplay
  session={session}
  onRefresh={createSession}
  className="flex flex-col items-center gap-4"
  qrProps={{ imageProps: { className: 'w-64 h-64' } }}
  statusProps={{ className: 'text-sm font-medium' }}
  refreshButtonProps={{ className: 'text-blue-600 hover:underline text-sm' }}
/>
```

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
import { useQRPairing } from '@bsv/wallet-relay/react'

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

### RequestLog

`import { RequestLog } from '@bsv/wallet-relay/react'`

Unstyled RPC request log showing call history with status and results.

Renders an empty-state element when `entries` is empty. Each entry element gets a `data-state` attribute of `pending`, `error`, or `ok` for CSS-based styling without class logic.

#### Props

```ts
type RequestLogProps = {
  entries:     RequestLogEntry[]
  emptyProps?: React.HTMLAttributes<HTMLDivElement>
  entryProps?: React.HTMLAttributes<HTMLDivElement>
} & React.HTMLAttributes<HTMLDivElement>
```

| Prop | Description |
|------|-------------|
| `entries` | Log entries from `useWalletRelayClient`, newest first. |
| `emptyProps` | Props on the empty-state `<div>`. Gets `data-state="empty"`. |
| `entryProps` | Props on each entry `<div>`. Gets `data-state="pending" \| "error" \| "ok"`. |
| `children` | Content shown as the empty state when `entries` is empty. Default: `'No requests yet'`. |
| `...rootProps` | All other props spread onto the root `<div>`. |

Each entry renders three sub-elements: `<span data-log-method>`, `<span data-log-status>`, and (once resolved) `<pre data-log-result>`.

#### Example

```tsx
<RequestLog
  entries={log}
  className="flex flex-col gap-2 overflow-y-auto max-h-72"
  entryProps={{ className: 'rounded border p-3 text-xs font-mono' }}
  emptyProps={{ className: 'text-gray-400 text-center py-6' }}
/>
```

---

## Building blocks

These classes are exported from '@bsv/wallet-relay' (server entry) and can be composed freely for advanced use cases.

---

### WebSocketRelay

`import { WebSocketRelay } from '@bsv/wallet-relay'`

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

`import { QRSessionManager } from '@bsv/wallet-relay'`

In-memory session store with automatic garbage collection.

- Session IDs are 32-byte random base64url strings, also used as WS topic and BSV wallet keyID
- Pairing window: 120 s (pending sessions become `expired` after this)
- Session TTL: 30 days (sessions are GC'd from memory after this)
- GC runs every 10 minutes

#### Constructor

```ts
new QRSessionManager(options?: { maxSessions?: number })
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxSessions` | `number` | unlimited | Maximum concurrent sessions. `createSession()` throws with a `429`-style error when the limit is reached. |

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

`import { WalletRequestHandler } from '@bsv/wallet-relay'`

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

Available from both `@bsv/wallet-relay` and `@bsv/wallet-relay/client`.

---

### parsePairingUri

```ts
function parsePairingUri(raw: string): ParseResult
```

Parses and validates a `bsv-browser://pair?…` QR code URI. Returns `{ params, error: null }` on success or `{ params: null, error: string }` on failure.

Validations performed:

| Check | Detail |
|-------|--------|
| Protocol | Must be `bsv-browser:` |
| Required fields | `topic`, `backendIdentityKey`, `protocolID`, `origin`, `expiry` all present |
| Expiry | `expiry` must be in the future |
| Origin scheme | Must be `http://` or `https://` |
| Identity key format | Must match compressed secp256k1 (`/^0[23][0-9a-fA-F]{64}$/`) |
| protocolID | Must be valid JSON of shape `[number, string]` |
| sig | Optional — passed through as-is; verify with `verifyPairingSignature` |

The relay URL is not validated here — it is not present in the QR. The mobile fetches it from the origin server via `resolveRelay()` after the user approves the connection. Old QR codes that include a `relay` param are accepted; the param is silently ignored.

---

### buildPairingUri

```ts
function buildPairingUri(params: {
  sessionId:          string
  backendIdentityKey: string
  protocolID:         string   // JSON.stringify(PROTOCOL_ID)
  origin:             string
  pairingTtlMs?:      number   // default: 120_000 (2 minutes)
  expiry?:            number   // Unix seconds — override computed expiry (required when signing, so the same value is used in both the signature and the URI)
  sig?:               string   // base64url signature from WalletRelayService when signQrCodes is true
}): string
```

Builds a `bsv-browser://pair?…` URI from session parameters. The `sessionId` is used as `topic`. Expiry is computed as `Math.floor((Date.now() + pairingTtlMs) / 1000)` unless `expiry` is provided explicitly — pass an explicit value when signing so the signature and URI cover the same expiry.

The relay URL is intentionally omitted from the URI. The mobile fetches it from `{origin}/api/session/{sessionId}` after scanning — this is the trust anchor.

---

### verifyPairingSignature

```ts
function verifyPairingSignature(params: PairingParams): Promise<boolean>
```

Verifies the `sig` field embedded in a parsed `PairingParams` object. Returns `true` immediately (no-op) when `params.sig` is absent — backward compatible with servers that have `signQrCodes: false`. Returns `false` if the signature is present but invalid or the data has been tampered with.

Uses a `ProtoWallet(PrivateKey(1))` verifier with `counterparty: 'anyone'` — no mobile wallet key is required.

```ts
const { params, error } = parsePairingUri(scannedUri)
if (error) { showError(error); return }

if (!await verifyPairingSignature(params)) {
  showError('QR code signature is invalid — do not connect')
  return
}

// Safe to proceed with resolveRelay() and connect()
```

Available from `@bsv/wallet-relay/client` only (not the server entry — the server signs, the mobile verifies).

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

All types are exported from both `@bsv/wallet-relay` and `@bsv/wallet-relay/client`.

---

### WalletLike

```ts
type WalletLike = Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt' | 'createSignature'>
```

Minimal wallet interface required by the library. Satisfied by `ProtoWallet` and `WalletClient` from `@bsv/sdk`, as well as any object that implements the four methods. `createSignature` is used by `WalletRelayService` when signing QR codes (`signQrCodes: true`).

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

### SessionInfo

The shape returned by `GET /api/session` (session creation) and polled via `GET /api/session/:id`. Used as the state type in `useWalletRelayClient` and `WalletRelayClient`.

```ts
interface SessionInfo {
  sessionId:     string
  status:        SessionStatus
  qrDataUrl?:    string   // present on session creation — base64 PNG data URL
  pairingUri?:   string   // present on session creation — pass to QRPairingCode / useQRPairing
  desktopToken?: string   // present on session creation — pass as ?token= in the desktop WS URL
}
```

`qrDataUrl`, `pairingUri`, and `desktopToken` are only present on the initial `GET /api/session` response. Status-poll responses (`GET /api/session/:id`) return `sessionId`, `status`, and `relay`.

---

### PairingParams

```ts
interface PairingParams {
  topic:              string    // Session ID
  backendIdentityKey: string    // Compressed secp256k1 public key
  protocolID:         string    // JSON-encoded [number, string] tuple
  origin:             string    // http(s):// backend API root — mobile fetches relay from here
  expiry:             string    // Unix seconds
  sig?:               string    // base64url ECDSA signature — verify with verifyPairingSignature
}
```

The relay URL is not part of `PairingParams`. It is fetched separately via `WalletPairingSession.resolveRelay()` after the user approves the connection.

---

### ParseResult

```ts
type ParseResult =
  | { params: PairingParams; error: null }
  | { params: null;          error: string }
```

---

### WalletRequest / WalletResponse / RequestLogEntry

Available from `@bsv/wallet-relay/client`.

Used by `WalletRelayClient`, `useWalletRelayClient`, and the `RequestLog` component to track in-flight and completed RPC calls.

```ts
interface WalletRequest {
  requestId: string   // Client-generated UUID (separate from the wire-level RPC id)
  method:    string
  params:    unknown
  timestamp: number   // Unix ms — when the request was sent
}

interface WalletResponse {
  requestId: string
  result?:   unknown
  error?:    { code: number; message: string }
  timestamp: number   // Unix ms — when the response arrived
}

interface RequestLogEntry {
  request:   WalletRequest
  response?: WalletResponse   // undefined while pending
  pending:   boolean
}
```

---

### PROTOCOL_ID

```ts
const PROTOCOL_ID: WalletProtocol = [0, 'mobile wallet session']
```

The BSV wallet protocol ID used for all message encryption in this library. Pass this as `protocolID` when constructing `CryptoParams` manually.
