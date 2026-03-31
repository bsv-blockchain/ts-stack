# @bsv/wallet-relay

BSV mobile wallet QR pairing — relay server, session management, and desktop frontend utilities.

Lets any web app offer "connect via mobile wallet" as a signing or authentication option. The desktop shows a QR code; the user scans it with their BSV wallet app; from that point all wallet operations are handled by the mobile over an encrypted WebSocket relay. Wallet keys never leave the mobile device. The relay never sees plaintext.

---

## Who needs what

| You are | What you need |
|---------|---------------|
| **Web app developer** adding mobile wallet support to a site | Backend: one `WalletRelayService` call. Frontend: `useWalletRelayClient` + `WalletConnectionModal` + `QRDisplay` from `@bsv/wallet-relay/react` |
| **Mobile wallet developer** adding QR pairing to a wallet app | `WalletPairingSession` from `@bsv/wallet-relay/client` |

**Most integrators are in the first group.** If you're building a website that lets users connect their mobile BSV wallet, you do not touch the mobile side at all. The `WalletPairingSession` API exists for wallet app developers (like BSV Browser) who are implementing the mobile end of the protocol.

---

## Quickstart — web app

### 1. Install

```bash
npm install @bsv/wallet-relay @bsv/sdk
npm install express cors ws qrcode   # backend peer deps — not needed for frontend-only projects
```

`@bsv/sdk` is used throughout — backend wallet crypto, frontend local wallet detection, and mobile pairing. Install it in every layer of your project.

> **TypeScript:** your `tsconfig.json` needs `"moduleResolution": "bundler"` (or `"node16"` / `"nodenext"`) to resolve the `@bsv/wallet-relay/react` and `@bsv/wallet-relay/client` subpath exports.

### 2. Generate a stable backend key

The backend needs a fixed private key. The mobile derives its ECDH shared secret from the backend's identity key, which is embedded in the QR code — so **the same key must be used across server restarts**. Generate it once and store it in `.env`:

```bash
node --input-type=commonjs -e "const {PrivateKey}=require('@bsv/sdk'); console.log(PrivateKey.fromRandom().toHex())"
```

`.env`:
```
WALLET_PRIVATE_KEY=<hex output from above — keep secret, never commit>
RELAY_URL=ws://localhost:3000
ORIGIN=http://localhost:5173
```

- `RELAY_URL` — WebSocket address mobile devices connect to. In production this must be a publicly reachable URL (e.g. `wss://yourapp.com`) — not localhost.
- `ORIGIN` — URL your frontend runs on. Used for CORS on the backend.

> **Hostname constraint:** for `wss://` relays, `RELAY_URL` and `ORIGIN` must share the same hostname. The mobile app enforces this when scanning the QR — a mismatched relay hostname is rejected as potentially malicious. `wss://yourapp.com` + `https://yourapp.com` ✓ — `wss://relay.otherdomain.com` + `https://yourapp.com` ✗. `ws://` (local dev only) is exempt.

### 3. App setup

<details open>
<summary><strong>Scaffold (recommended)</strong></summary>

```bash
npx @bsv/wallet-relay init
```

Generates a working Express backend and React+Vite frontend wired together. Existing files are never overwritten.

```
backend/
  server.ts          — Express + WalletRelayService, reads env vars
  .env.example       — copy to .env and fill in WALLET_PRIVATE_KEY
frontend/
  hooks/
    useWalletSession.ts    — re-exports useWalletRelayClient from @bsv/wallet-relay/react
  components/
    WalletConnectionModal.tsx  — styled wrapper around @bsv/wallet-relay/react WalletConnectionModal
    QRDisplay.tsx              — styled wrapper around @bsv/wallet-relay/react QRDisplay
    WalletActions.tsx          — buttons for each wallet method (app-specific, customise here)
    RequestLog.tsx             — styled wrapper around @bsv/wallet-relay/react RequestLog
  views/
    DesktopView.tsx    — composes all of the above
  types/
    wallet.ts          — WalletMethod (app-specific); re-exports shared types from @bsv/wallet-relay/client
```

Options: `--nextjs` for a Next.js project, `--backend` / `--frontend` for one side only, `--backend-dir` / `--frontend-dir` to control output directories.

The scaffolded files contain `TODO` comments marking the spots you're expected to customise — wallet method implementations, app-specific UI copy, and the `installUrl` in `WalletConnectionModal` (defaults to `https://desktop.bsvb.tech`, the BSV wallet with desktop and mobile support).

**After scaffolding:**

```bash
cp backend/.env.example backend/.env
# Fill in WALLET_PRIVATE_KEY in backend/.env, then:
npm run dev --prefix backend
npm run dev --prefix frontend
```

</details>

<details>
<summary><strong>Manual setup</strong></summary>

#### Backend

```ts
import express from 'express'
import { createServer } from 'http'
import cors from 'cors'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
import { WalletRelayService } from '@bsv/wallet-relay'

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173'

const app    = express()
app.use(cors({
  origin: ORIGIN,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Desktop-Token'],
}))
app.use(express.json())

const server = createServer(app)
const wallet = new ProtoWallet(PrivateKey.fromHex(process.env.WALLET_PRIVATE_KEY!))

new WalletRelayService({ app, server, wallet })

server.listen(3000)
```

That's the entire backend. `WalletRelayService` registers three REST routes and the `/ws` WebSocket endpoint automatically:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/session` | Create session, return `{ sessionId, status, qrDataUrl, pairingUri, desktopToken }` |
| `GET` | `/api/session/:id` | Poll session status |
| `POST` | `/api/request/:id` | Send a wallet RPC call to the paired mobile |

`relayUrl` and `origin` are optional — they default to `process.env.RELAY_URL` / `process.env.ORIGIN`, then `ws://localhost:3000` / `http://localhost:5173`.

> **`desktopToken`** is returned by `GET /api/session` and must be sent as an `X-Desktop-Token` header on every `POST /api/request/:id` call. It ensures that only the frontend that created the session can send wallet requests — even if another client somehow learns the `sessionId`. `useWalletRelayClient` / `WalletRelayClient` handle this automatically. If you are calling `relay.sendRequest()` directly from your own route handlers (Next.js, etc.) you must forward the header yourself — see [Next.js setup](#nextjs-setup) below.

> **CORS:** if your frontend and backend run on different origins, you must include `X-Desktop-Token` in your CORS `allowedHeaders`. Without it the browser's preflight check blocks every `POST /api/request/:id` call. The example above already includes it — don't remove it.

#### Frontend

`@bsv/wallet-relay/react` exports everything needed for wallet detection and QR pairing:

```tsx
import { useState, useCallback } from 'react'
import type { WalletClient } from '@bsv/sdk'
import {
  useWalletRelayClient,
  WalletConnectionModal,
  QRDisplay,
} from '@bsv/wallet-relay/react'

export function App() {
  const [mode, setMode] = useState<'detecting' | 'local' | 'mobile'>('detecting')

  // autoCreate: false — only start a backend session when the user picks the mobile path
  const { session, error, createSession, sendRequest } = useWalletRelayClient({
    autoCreate: false,
  })

  const handleLocalWallet = useCallback((wallet: WalletClient) => {
    setMode('local')
    // TODO: store wallet and use it in your app
  }, [])

  return (
    <>
      {mode === 'detecting' && (
        <WalletConnectionModal
          onLocalWallet={handleLocalWallet}
          onMobileQR={() => { setMode('mobile'); void createSession() }}
        />
      )}

      {mode === 'mobile' && (
        <>
          {error && <p>{error}</p>}
          <QRDisplay session={session} onRefresh={createSession} />
        </>
      )}

      {mode === 'local' && (
        <>{/* TODO: render your app here using the local wallet */}</>
      )}
    </>
  )
}
```

`WalletConnectionModal` silently checks for a local BSV wallet first:
- **Local wallet found** → calls `onLocalWallet` immediately, renders nothing
- **Not found** → renders an install link and a "Connect via Mobile QR" button

`QRDisplay` shows the QR image, a status badge (`pending` / `connected` / `disconnected` / `expired`), and a refresh button when the session expires. Both components are unstyled — pass `className`, `style`, and per-element props to style them. See [API.md](./API.md) for the full prop reference.

</details>

### Next.js setup

> **Serverless / edge deployments (Vercel, Netlify, Lambda) are not supported.** The WebSocket relay requires a persistent Node.js process — it cannot run in a stateless function environment. You need a long-lived server (a VPS, a container, or a self-hosted Next.js deployment with a custom server).

The WebSocket endpoint (`/ws`) cannot be attached to Next.js's internal HTTP server from inside an API route — you must use a **custom server** so you control the underlying `http.Server` instance. The REST routes (`/api/session`, `/api/session/:id`, `/api/request/:id`) are handled by normal Next.js API routes that call `relay` methods directly.

**Step 1 — custom server** (create `server.ts` at the project root, then update `package.json` to run it instead of `next start`):

```ts
// server.ts
import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
import { WalletRelayService } from '@bsv/wallet-relay'

const dev    = process.env.NODE_ENV !== 'production'
const app    = next({ dev })
const handle = app.getRequestHandler()

await app.prepare()

const server = createServer((req, res) => {
  handle(req, res, parse(req.url!, true))
})

export const relay = new WalletRelayService({
  server,
  wallet: new ProtoWallet(PrivateKey.fromHex(process.env.WALLET_PRIVATE_KEY!)),
})

server.listen(3000)
```

```json
// package.json — replace "next start" with the custom server
{ "scripts": { "start": "tsx server.ts", "dev": "tsx server.ts" } }
```

**Step 2 — API routes** call `relay` methods directly. You must forward `X-Desktop-Token` on the request route — the library cannot do it for you since it has no access to the incoming request object.

```ts
// app/api/session/route.ts
import { relay } from '@/server' // the custom server exports relay

export async function GET() {
  const info = await relay.createSession()
  return Response.json(info) // includes desktopToken — WalletRelayClient stores it automatically
}
```

```ts
// app/api/session/[id]/route.ts
import { relay } from '@/server'

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const info = relay.getSession(params.id)
  if (!info) return Response.json({ error: 'Session not found' }, { status: 404 })
  return Response.json(info)
}
```

```ts
// app/api/request/[id]/route.ts
import { relay } from '@/server'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { method, params: rpcParams } = await req.json() as { method: string; params: unknown }
  // Forward the desktop token — required to authenticate the request
  const token = req.headers.get('x-desktop-token') ?? undefined
  try {
    const result = await relay.sendRequest(params.id, method, rpcParams, token)
    return Response.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Request failed'
    const status = msg === 'Invalid desktop token' ? 401 : msg.startsWith('Session is') ? 400 : 504
    return Response.json({ error: msg }, { status })
  }
}
```

The frontend is identical to the Vite/Express setup — `useWalletRelayClient` works the same regardless of backend framework.

### 4. Use the wallet proxy — no call site changes needed

`useWalletRelayClient` returns a `wallet` object alongside `session`. Once `session?.status === 'connected'`, `wallet` is a fully `WalletInterface`-compatible proxy that forwards every call to the paired mobile over the relay. When the session is not connected, `wallet` is `null`.

**This means you do not need separate code paths for mobile vs local wallet.** The proxy has the same method signatures as `WalletClient` — swap the `wallet` reference in your existing wallet context and every call site in your app continues to work unchanged:

```tsx
// Before (local WalletClient):
const { publicKey } = await wallet.getPublicKey({ identityKey: true })
const { certificates } = await wallet.listCertificates({ certifiers: [...], types: [...] })
const { txid } = await wallet.createAction({ description: 'Pay invoice', outputs: [...] })

// After (mobile relay proxy — identical call sites, zero changes):
const { publicKey } = await wallet.getPublicKey({ identityKey: true })
const { certificates } = await wallet.listCertificates({ certifiers: [...], types: [...] })
const { txid } = await wallet.createAction({ description: 'Pay invoice', outputs: [...] })
```

How it works: each method on the proxy captures its name at construction time, calls `sendRequest(method, params)` internally, unwraps `res.result`, and throws on `res.error` — so callers see a normal return value or a thrown `Error`, exactly as they would from a local `WalletClient`.

```tsx
// Typical integration — inject into your existing wallet context on connect:
const { session, wallet } = useWalletRelayClient({ autoCreate: false })

useEffect(() => {
  if (session?.status === 'connected' && wallet) {
    setWalletContext(wallet) // drop-in — all existing wallet calls now route to mobile
  }
}, [session?.status, wallet])
```

The proxy is created once and cached for the lifetime of the session. Available methods: `getPublicKey`, `listOutputs`, `createAction`, `signAction`, `createSignature`, `listActions`, `internalizeAction`, `acquireCertificate`, `relinquishCertificate`, `listCertificates`, `revealCounterpartyKeyLinkage`.

> **Lower-level option:** `sendRequest(method, params)` is still available if you need the raw `{ result, error, requestId, timestamp }` response envelope — useful for request logging or custom error handling.

---

## For mobile wallet developers

If you are building a BSV wallet app and want to support QR pairing with desktop web apps, use `WalletPairingSession` from `@bsv/wallet-relay/client`:

```ts
import { WalletClient } from '@bsv/sdk'
import { WalletPairingSession, parsePairingUri } from '@bsv/wallet-relay/client'

const result = parsePairingUri(scannedUri)
if (result.error) { showError(result.error); return }

const wallet  = new WalletClient('auto')
const session = new WalletPairingSession(wallet, result.params, {
  // Defaults to the full BSV Browser method set — override only if needed:
  // implementedMethods: new Set(['getPublicKey', 'createAction']),
  // autoApproveMethods: new Set(['getPublicKey']),
  onApprovalRequired: async (method, params) => await showApprovalModal(method, params),
  walletMeta: { name: 'My Wallet', version: '1.0' },
})

session
  // WalletClient implements WalletInterface but isn't string-indexed — cast required
  .onRequest(async (method, params) => (wallet as Record<string, (p: unknown) => Promise<unknown>>)[method](params))
  .on('connected',    () => setStatus('connected'))
  .on('disconnected', () => setStatus('disconnected'))
  .on('error',        msg => setError(msg))

await session.connect()
```

To resume after a network drop, pass the last seen seq so replay protection picks up from where it left off:

```ts
const lastSeq = await SecureStore.getItemAsync(`lastseq_${topic}`)
await session.reconnect(Number(lastSeq ?? 0))
```

`DEFAULT_IMPLEMENTED_METHODS` and `DEFAULT_AUTO_APPROVE_METHODS` are exported from `@bsv/wallet-relay/client` if you want to reference or extend the defaults.

---

## React components

`@bsv/wallet-relay/react` exports six items:

| Export | Description |
|--------|-------------|
| `useWalletRelayClient` | Session creation, status polling, `wallet` proxy (drop-in `WalletInterface`), and `sendRequest` — the main hook for QR pairing |
| `WalletConnectionModal` | Detects local wallet; shows install link + mobile QR button if none found |
| `QRDisplay` | QR image with status badge and session refresh |
| `QRPairingCode` | Tappable QR that opens the `wallet://pair?…` deeplink directly |
| `RequestLog` | Live request/response log (useful for debugging and demo UIs) |
| `useQRPairing` | Cross-platform deeplink hook — use directly in React Native |

All visual components are unstyled. Pass `className`, `style`, and per-element props to style them. See [API.md](./API.md) for full prop documentation.

**React Native** — use `useQRPairing` directly instead of `QRPairingCode`:

```tsx
import { Linking } from 'react-native'
import { useQRPairing } from '@bsv/wallet-relay/react'

const { open } = useQRPairing(pairingUri, { openUrl: Linking.openURL })

return (
  <TouchableOpacity onPress={open}>
    <Image source={{ uri: qrDataUrl }} style={styles.qr} />
  </TouchableOpacity>
)
```

---

## Advanced usage — building blocks

All internal classes are exported for custom composition: custom session stores, non-Express frameworks, alternative transports.

```ts
import {
  WebSocketRelay,
  QRSessionManager,
  WalletRequestHandler,
  buildPairingUri,
  encryptEnvelope,
  decryptEnvelope,
} from '@bsv/wallet-relay'

const sessions = new QRSessionManager()
const relay    = new WebSocketRelay(server)
const handler  = new WalletRequestHandler()

relay.onValidateTopic(topic => sessions.getSession(topic) !== null)
relay.onIncoming((topic, envelope, role) => { /* custom logic */ })
sessions.onSessionExpired(id => relay.removeTopic(id))
```

The high-level facades (`WalletRelayService`, `WalletPairingSession`) follow semver strictly. The building blocks are stable but may have more targeted breaking changes between minor versions.

---

## Encryption model

All messages use BSV wallet-native ECDH via `@bsv/sdk`. No custom crypto.

- Each side calls `wallet.encrypt({ protocolID, keyID: sessionId, counterparty })` where `counterparty` is the other party's identity public key
- The relay routes ciphertext blobs — it never decrypts anything
- The pairing bootstrap sends `mobileIdentityKey` unencrypted in the outer envelope once (on `pairing_approved`) so the backend can verify the inner payload. All subsequent messages use only the stored key.

`WalletLike` throughout is `Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>` — satisfied by both `ProtoWallet` and `WalletClient` from `@bsv/sdk`.

---

## Entry points

| Import | Environment | Contains |
|--------|-------------|----------|
| `@bsv/wallet-relay` | Node.js only | `WalletRelayService`, `WebSocketRelay`, `QRSessionManager`, `WalletRequestHandler`, shared utilities |
| `@bsv/wallet-relay/client` | Browser + React Native | `WalletRelayClient`, `WalletPairingSession`, `WalletMethodName`, shared utilities, no Node.js deps |
| `@bsv/wallet-relay/react` | React ≥17 | `useWalletRelayClient`, `WalletConnectionModal`, `QRDisplay`, `QRPairingCode`, `RequestLog`, `useQRPairing` |

---

## API reference

See [API.md](./API.md) for full parameter and method documentation.
