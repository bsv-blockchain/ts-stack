# qr-lib

BSV mobile wallet QR pairing — relay server, session management, and desktop frontend utilities.

Lets any web app offer "connect via mobile wallet" as a signing or authentication option. The desktop shows a QR code; the user scans it with their BSV wallet app; from that point all wallet operations are handled by the mobile over an encrypted WebSocket relay. Wallet keys never leave the mobile device. The relay never sees plaintext.

---

## Who needs what

| You are | What you need |
|---------|---------------|
| **Web app developer** adding mobile wallet support to a site | Backend + frontend only — two files and a template component |
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
    useWalletSession.ts    — session creation, status polling, sendRequest
  components/
    WalletConnectionModal.tsx  — local wallet detection + install/QR modal
    QRDisplay.tsx              — QR image with status badge and refresh
    WalletActions.tsx          — buttons for each wallet method
    RequestLog.tsx             — live request/response log
  views/
    DesktopView.tsx    — composes all of the above
  types/
    wallet.ts          — WalletMethod, RequestLogEntry, etc.
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

The scaffolded frontend includes `WalletConnectionModal` — a component that silently checks for a local BSV wallet first, and only shows the QR pairing option if none is found. This gives users the best available experience automatically:

- **Local wallet present** → uses it directly, no modal shown
- **No local wallet** → modal appears with two choices: install a wallet, or connect via mobile QR

```tsx
import { useState, useCallback } from 'react'
import { WalletClient } from '@bsv/sdk'
import { WalletConnectionModal } from './components/WalletConnectionModal'
import { MobileQRContent }       from './views/DesktopView'

type WalletMode = 'detecting' | 'local' | 'mobile'

export function App() {
  const [mode, setMode] = useState<WalletMode>('detecting')

  const handleLocalWallet = useCallback((wallet: WalletClient) => {
    setMode('local')
    // TODO: store wallet and use it for signing / auth in your app
  }, [])

  return (
    <>
      {mode === 'detecting' && (
        <WalletConnectionModal
          onLocalWallet={handleLocalWallet}
          onMobileQR={() => setMode('mobile')}
        />
      )}
      {mode === 'mobile' && <MobileQRContent />}
      {mode === 'local'  && <YourAppContent />}
    </>
  )
}
```

The `MobileQRContent` component (from the scaffold) handles session creation, QR display, status polling, and the request log.

Once the mobile has scanned and `session.status === 'connected'`, use `sendRequest` from `useWalletSession` to call any wallet method on the mobile:

```ts
const { session, sendRequest } = useWalletSession()

// Example: fetch the user's identity public key
if (session?.status === 'connected') {
  const response = await sendRequest('getPublicKey', { identityKey: true })
  if (response?.result) {
    console.log('Public key:', response.result)
  }
}

// Example: create a transaction action
const response = await sendRequest('createAction', {
  description: 'My transaction',
  outputs: [{ script: '...', satoshis: 1000 }],
})
```

`sendRequest` posts to `POST /api/request/:id` on your backend, which encrypts the call and relays it to the mobile. The mobile executes it and sends back the response — all over the encrypted WebSocket relay. Available methods match what the mobile wallet supports: `getPublicKey`, `listOutputs`, `createAction`, `signAction`, `listActions`, `internalizeAction`, `acquireCertificate`, `relinquishCertificate`, `revealCounterpartyKeyLinkage`.

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

## React component

Renders a tappable QR code. On mobile browsers, tapping opens the `wallet://pair?…` deeplink directly — no camera scan needed when the user is already on a mobile device.

```tsx
import { QRPairingCode } from 'qr-lib/react'

<QRPairingCode
  qrDataUrl={session.qrDataUrl}
  pairingUri={session.pairingUri}
  className="rounded-xl shadow-lg"
  imageProps={{ className: 'w-64 h-64', alt: 'Scan to connect wallet' }}
/>
```

**React Native** — use `useQRPairing` directly:

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
| `qr-lib/client` | Browser + React Native | `WalletPairingSession`, shared utilities, no Node.js deps |
| `qr-lib/react` | React ≥17 | `QRPairingCode`, `useQRPairing` |

---

## API reference

See [API.md](./API.md) for full parameter and method documentation.
