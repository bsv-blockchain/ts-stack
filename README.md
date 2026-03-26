# qr-lib

BSV mobile wallet QR pairing — relay server, pairing client, and React component.

Handles the full `wallet://pair?…` protocol: session creation, QR generation, WebSocket relay, ECDH encryption, and mobile-side RPC dispatch. All wallet keys stay on the mobile device. The relay never sees plaintext.

---

## Install

```bash
npm install qr-lib @bsv/sdk
```

Peer dependencies — install only what your target needs:

```bash
# Server (Node.js)
npm install express ws qrcode

# React component
npm install react
```

---

## Two levels of control

**Level 1 — High-level facades (recommended starting point)**

`WalletRelayService` and `WalletPairingSession` wire everything up in a single constructor call. You configure callbacks; the library handles WebSockets, encryption, session lifecycle, and the pairing handshake.

**Level 2 — Direct use of building blocks (advanced)**

All internal classes are exported and composable: `WebSocketRelay`, `QRSessionManager`, `WalletRequestHandler`, `encryptEnvelope`, `decryptEnvelope`, `parsePairingUri`. Use these when you need custom routing, your own transport, a different session store, or non-standard approval flows.

The high-level facades are the intended public API and will follow semver strictly. The building blocks are stable but may have more targeted breaking changes between minor versions.

---

## Server setup (Node.js + Express)

```ts
import express from 'express'
import { createServer } from 'http'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
import { WalletRelayService } from 'qr-lib'

const app = express()
app.use(express.json())

const server = createServer(app)
const wallet = new ProtoWallet(PrivateKey.fromString(process.env.SERVER_PRIVATE_KEY!))

const relay = new WalletRelayService({
  app,
  server,
  wallet,
  relayUrl: process.env.RELAY_URL ?? 'ws://localhost:3000',
  origin:   process.env.ORIGIN   ?? 'http://localhost:5173',
})

server.listen(3000)
```

This registers three REST routes and the `/ws` WebSocket endpoint automatically:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/session` | Create session, return `{ sessionId, status, qrDataUrl }` |
| `GET` | `/api/session/:id` | Poll session status |
| `POST` | `/api/request/:id` | Relay an RPC call to the mobile wallet |

> **Rate limiting:** `WalletRelayService` registers its routes in the constructor. Apply any Express rate-limit middleware to those paths *before* constructing the service.

---

## Mobile pairing client (browser / React Native)

```ts
import { WalletClient } from '@bsv/sdk'
import { WalletPairingSession, parsePairingUri } from 'qr-lib/client'

const result = parsePairingUri(scannedUri)
if (result.error) { showError(result.error); return }

const wallet = new WalletClient()

const session = new WalletPairingSession(wallet, result.params, {
  implementedMethods:  new Set(['getPublicKey', 'createAction']),
  autoApproveMethods:  new Set(['getPublicKey']),
  onApprovalRequired:  async (method, params) => await showApprovalModal(method, params),
  walletMeta:          { name: 'My Wallet', version: '1.0' },
})

session
  .onRequest(async (method, params) => wallet[method](params))
  .on('connected',    () => setStatus('connected'))
  .on('disconnected', () => setStatus('disconnected'))
  .on('error',        msg => setError(msg))

await session.connect()
```

---

## React component

Renders a tappable QR code. On mobile browsers, tapping opens the `wallet://pair?…` deeplink directly — no camera scan needed, since the user is already on the mobile device.

```tsx
import { QRPairingCode } from 'qr-lib/react'

// Basic
<QRPairingCode
  qrDataUrl={session.qrDataUrl}
  pairingUri={pairingUri}
/>

// Custom styling via standard HTML props
<QRPairingCode
  qrDataUrl={session.qrDataUrl}
  pairingUri={pairingUri}
  className="rounded-xl shadow-lg cursor-pointer"
  imageProps={{ className: 'w-64 h-64', alt: 'Scan to connect' }}
/>

// Replace the image entirely with children
<QRPairingCode qrDataUrl={session.qrDataUrl} pairingUri={pairingUri}>
  <MyCustomQRRenderer data={pairingUri} size={256} />
</QRPairingCode>
```

**React Native** — use the `useQRPairing` hook directly:

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

## Advanced usage — building blocks directly

```ts
import {
  WebSocketRelay,
  QRSessionManager,
  WalletRequestHandler,
  buildPairingUri,
  encryptEnvelope,
  decryptEnvelope,
} from 'qr-lib'

// Compose your own service with a custom session store or transport
const sessions = new QRSessionManager()
const relay    = new WebSocketRelay(server)
const handler  = new WalletRequestHandler()

relay.onValidateTopic(topic => sessions.getSession(topic) !== null)
relay.onIncoming((topic, envelope, role) => { /* custom logic */ })

sessions.onSessionExpired(id => relay.removeTopic(id))
```

---

## Encryption model

All messages use BSV wallet-native ECDH via `@bsv/sdk`. No custom crypto.

- Each side uses `wallet.encrypt({ protocolID, keyID: sessionId, counterparty })` where `counterparty` is the other party's identity public key.
- The relay routes ciphertext blobs — it never decrypts anything.
- The pairing bootstrap sends `mobileIdentityKey` unencrypted in the outer envelope only once (on `pairing_approved`) so the backend can verify the inner payload. All subsequent messages use only the stored key.

The `WalletLike` type accepted throughout is `Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt'>` — satisfied by both `ProtoWallet` and `WalletClient` from `@bsv/sdk`.

---

## Entry points

| Import | Use for |
|--------|---------|
| `qr-lib` | Server / Node.js — all server classes + shared utilities |
| `qr-lib/client` | Browser + React Native — `WalletPairingSession` + shared utilities, no Node.js deps |
| `qr-lib/react` | React component and hook — peer dep on `react >=17` |

---

## API reference

See [API.md](./API.md) for full parameter and method documentation.
