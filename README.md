# qr-lib

BSV mobile wallet QR pairing — relay server, session management, and desktop frontend utilities.

Lets any web app offer "connect via mobile wallet" as a signing or authentication option. The desktop shows a QR code; the user scans it with their BSV wallet app; from that point all wallet operations are handled by the mobile over an encrypted WebSocket relay. Wallet keys never leave the mobile device. The relay never sees plaintext.

---

## Who needs what

| You are | What you need |
|---------|---------------|
| **Web app developer** adding mobile wallet support to a site | Backend: one `WalletRelayService` call. Frontend: `useWalletRelayClient` + `WalletConnectionModal` + `QRDisplay` from `qr-lib/react` |
| **Mobile wallet developer** adding QR pairing to a wallet app | `WalletPairingSession` from `qr-lib/client` |

**Most integrators are in the first group.** If you're building a website that lets users connect their mobile BSV wallet, you do not touch the mobile side at all. The `WalletPairingSession` API exists for wallet app developers (like BSV Browser) who are implementing the mobile end of the protocol.

---

## Quickstart — web app

### 1. Install

```bash
npm install qr-lib @bsv/sdk
npm install express cors ws qrcode   # server peer deps
```

`@bsv/sdk` is used throughout — backend wallet crypto, frontend local wallet detection, and mobile pairing. Install it in every layer of your project.

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

### 3. Scaffold (optional but recommended)

```bash
npx qr-lib init
```

Generates a working Express backend and React+Vite frontend wired together. Existing files are never overwritten.

```
backend/
  server.ts          — Express + WalletRelayService, reads env vars
  .env.example       — copy to .env and fill in WALLET_PRIVATE_KEY
frontend/
  hooks/
    useWalletSession.ts    — re-exports useWalletRelayClient from qr-lib/react
  components/
    WalletConnectionModal.tsx  — styled wrapper around qr-lib/react WalletConnectionModal
    QRDisplay.tsx              — styled wrapper around qr-lib/react QRDisplay
    WalletActions.tsx          — buttons for each wallet method (app-specific, customise here)
    RequestLog.tsx             — styled wrapper around qr-lib/react RequestLog
  views/
    DesktopView.tsx    — composes all of the above
  types/
    wallet.ts          — WalletMethod (app-specific); re-exports shared types from qr-lib/client
```

Options: `--nextjs` for a Next.js project, `--backend` / `--frontend` for one side only, `--backend-dir` / `--frontend-dir` to control output directories.

The scaffolded files contain `TODO` comments marking the spots you're expected to customise — wallet method implementations, app-specific UI copy, and the `installUrl` in `WalletConnectionModal` (defaults to `https://desktop.bsvb.tech`, the BSV wallet with desktop and mobile support).

### 4. Backend

```ts
import express from 'express'
import { createServer } from 'http'
import cors from 'cors'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
import { WalletRelayService } from 'qr-lib'

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173'

const app    = express()
app.use(cors({ origin: ORIGIN }))
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

> **`desktopToken`** is returned by `GET /api/session` but most apps using the polling approach above don't need it. It is only required if you open a direct desktop WebSocket connection (`/ws?role=desktop&token=<desktopToken>`). If you're just using the REST routes, ignore it.

### 5. Frontend

`qr-lib/react` exports everything needed for wallet detection and QR pairing — no scaffolding required:

```tsx
import { useState, useCallback } from 'react'
import { WalletClient } from '@bsv/sdk'
import {
  useWalletRelayClient,
  WalletConnectionModal,
  QRDisplay,
} from 'qr-lib/react'

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

      {mode === 'local' && <YourApp />}
    </>
  )
}
```

`WalletConnectionModal` silently checks for a local BSV wallet first:
- **Local wallet found** → calls `onLocalWallet` immediately, renders nothing
- **Not found** → renders an install link and a "Connect via Mobile QR" button

`QRDisplay` shows the QR image, a status badge (`pending` / `connected` / `disconnected` / `expired`), and a refresh button when the session expires. Both components are unstyled — pass `className`, `style`, and per-element props to style them. See [API.md](./API.md) for the full prop reference.

Once `session?.status === 'connected'`, use `sendRequest` to call any wallet method on the paired mobile:

```ts
// Fetch the user's identity public key
const pkResponse = await sendRequest('getPublicKey', { identityKey: true })
if (pkResponse.result) console.log('Public key:', pkResponse.result)

// Create a transaction
const txResponse = await sendRequest('createAction', {
  description: 'My transaction',
  outputs: [{ script: '...', satoshis: 1000 }],
})
```

`sendRequest` posts to `POST /api/request/:id` on your backend, which encrypts the call and relays it to the mobile. Available methods: `getPublicKey`, `listOutputs`, `createAction`, `signAction`, `createSignature`, `listActions`, `internalizeAction`, `acquireCertificate`, `relinquishCertificate`, `listCertificates`, `revealCounterpartyKeyLinkage`.

The scaffold (`npx qr-lib init`) generates Tailwind-styled versions of these components as a starting point for heavier customisation.

---

## For mobile wallet developers

If you are building a BSV wallet app and want to support QR pairing with desktop web apps, use `WalletPairingSession` from `qr-lib/client`:

```ts
import { WalletClient } from '@bsv/sdk'
import { WalletPairingSession, parsePairingUri } from 'qr-lib/client'

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
  .onRequest(async (method, params) => wallet[method](params))
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

`DEFAULT_IMPLEMENTED_METHODS` and `DEFAULT_AUTO_APPROVE_METHODS` are exported from `qr-lib/client` if you want to reference or extend the defaults.

---

## React components

`qr-lib/react` exports six items:

| Export | Description |
|--------|-------------|
| `useWalletRelayClient` | Session creation, status polling, and `sendRequest` — the main hook for QR pairing |
| `WalletConnectionModal` | Detects local wallet; shows install link + mobile QR button if none found |
| `QRDisplay` | QR image with status badge and session refresh |
| `QRPairingCode` | Tappable QR that opens the `wallet://pair?…` deeplink directly |
| `RequestLog` | Live request/response log (useful for debugging and demo UIs) |
| `useQRPairing` | Cross-platform deeplink hook — use directly in React Native |

All visual components are unstyled. Pass `className`, `style`, and per-element props to style them. See [API.md](./API.md) for full prop documentation.

**React Native** — use `useQRPairing` directly instead of `QRPairingCode`:

```tsx
import { Linking } from 'react-native'
import { useQRPairing } from 'qr-lib/react'

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
} from 'qr-lib'

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
| `qr-lib` | Node.js only | `WalletRelayService`, `WebSocketRelay`, `QRSessionManager`, `WalletRequestHandler`, shared utilities |
| `qr-lib/client` | Browser + React Native | `WalletRelayClient`, `WalletPairingSession`, shared utilities, no Node.js deps |
| `qr-lib/react` | React ≥17 | `useWalletRelayClient`, `WalletConnectionModal`, `QRDisplay`, `QRPairingCode`, `RequestLog`, `useQRPairing` |

---

## API reference

See [API.md](./API.md) for full parameter and method documentation.
