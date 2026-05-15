# CLAUDE.md — @bsv/wallet-relay v0.1.0

## Purpose
Wallet Relay enables mobile-to-desktop wallet pairing via QR codes and encrypted WebSocket tunnels. A web app (desktop browser) shows a QR code; user scans with their mobile BSV wallet; all wallet operations (signing, key retrieval, etc.) are proxied over HTTPS+WSS relay servers to the mobile without exposing keys or trust chains to the desktop. Provides both the relay server infrastructure (Node.js) and React frontend components for web apps to add "Connect Mobile Wallet" functionality.

## Public API Surface

### Server-Side (Node.js)
From root exports:
- **`WalletRelayService`** — All-in-one relay server; constructor: `new WalletRelayService(options: WalletRelayServiceOptions)` where options include:
  - `app: Express` — Express instance to register routes on
  - `server: http.Server` — HTTP server for WebSocket upgrade
  - `wallet: WalletLike` — Backend wallet (e.g., ProtoWallet)
  - `relayUrl?: string` — Public WebSocket URL (defaults to env.RELAY_URL)
  - `origin?: string` — Frontend origin for CORS (defaults to env.ORIGIN)
- Auto-registers three REST routes and WebSocket endpoint:
  - `GET /api/session` — Create new pairing session → returns `{ sessionId, qrDataUrl, pairingUri, desktopToken }`
  - `GET /api/session/:id` — Poll session status
  - `POST /api/request/:id` — Send wallet RPC call to paired mobile (requires X-Desktop-Token header)
  - `WS /ws` — WebSocket relay for bidirectional communication

### Lower-level components:
- **`QRSessionManager`** — Session lifecycle management (creation, status tracking, cleanup)
- **`WebSocketRelay`** — WebSocket server with message routing, topic validation, token auth
- **`WalletRequestHandler`** — Converts RPC calls to wallet method invocations

### Client-Side (Browser) — `@bsv/wallet-relay/client`
- **`WalletRelayClient`** — Direct HTTP/WebSocket client for session management and RPC calls; methods:
  - `createSession()` → `Promise<{ sessionId, qrDataUrl, pairingUri, desktopToken }>`
  - `getSessionStatus(sessionId)` → `Promise<SessionInfo>`
  - `sendRequest(sessionId, request, desktopToken)` → `Promise<RpcResponse>`

### React Components — `@bsv/wallet-relay/react`
- **`useWalletRelayClient(relayUrl?)`** — Hook wrapping WalletRelayClient; returns client instance
- **`useWalletSession(client, sessionId?)`** — Hook for session state management
- **`WalletConnectionModal`** — Pre-built UI component for QR pairing flow (shows modal, displays QR, handles scanning)
- **`QRDisplay`** — Standalone QR code display component
- **`RequestLog`** — UI for displaying pending/completed RPC requests

### Shared Types & Utilities
- **`Session`** — Session state: `{ id, status, qrData, pairingUri, desktopToken, mobileConnected, createdAt }`
- **`SessionStatus`** — Enum: `'pending' | 'paired' | 'disconnected' | 'expired'`
- **`PairingParams`** — QR encoding: `{ relayUrl, sessionId, sessionKey }`
- **`RpcRequest`** — Wallet call: `{ jsonrpc: '2.0', id, method, params }`
- **`RpcResponse`** — Call result: `{ jsonrpc: '2.0', id, result?, error? }`
- **`WireEnvelope`** — Encrypted message: `{ iv, ciphertext, tag, method, sessionId }`
- **`WalletLike`** — Any object implementing core wallet methods (createAction, signAction, etc.)

### Crypto & Encoding Utilities
From shared exports (also in `./client`):
- **`encryptEnvelope(message, key, iv?)`** → `WireEnvelope` — AES-256-GCM encryption
- **`decryptEnvelope(envelope, key)`** → `string` — Decryption
- **`parsePairingUri(uri)`** → `ParseResult` — Extract params from QR URI
- **`buildPairingUri(params)`** → `string` — Construct QR-scannable URI
- **`verifyPairingSignature(sig, message, pubKey)`** → `boolean` — ECDSA signature verification
- **`bytesToBase64url(bytes)`**, **`base64urlToBytes(b64)`** — URL-safe base64 encoding

### CLI Scaffolding
- **`npx @bsv/wallet-relay init`** — Command to scaffold Express backend + React frontend wired together
  - Options: `--nextjs`, `--backend`, `--frontend`, `--backend-dir`, `--frontend-dir`

## Real Usage Patterns

### 1. Set up relay server (Express + Node.js)
```typescript
import express from 'express'
import { createServer } from 'http'
import cors from 'cors'
import { WalletRelayService } from '@bsv/wallet-relay'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'

const app = express()
app.use(cors({
  origin: process.env.ORIGIN,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Desktop-Token']
}))
app.use(express.json())

const server = createServer(app)
const wallet = new ProtoWallet(PrivateKey.fromHex(process.env.WALLET_PRIVATE_KEY!))

new WalletRelayService({ 
  app, 
  server, 
  wallet,
  relayUrl: process.env.RELAY_URL,
  origin: process.env.ORIGIN
})

server.listen(3000)
```

### 2. Create session and get QR code (frontend React)
```typescript
import { useWalletRelayClient } from '@bsv/wallet-relay/react'
import { useEffect, useState } from 'react'

function WalletConnection() {
  const client = useWalletRelayClient('https://relay.example.com')
  const [qrData, setQrData] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  useEffect(() => {
    const setup = async () => {
      const session = await client.createSession()
      setSessionId(session.sessionId)
      setQrData(session.qrDataUrl)  // Base64 PNG
    }
    setup()
  }, [])

  return (
    <div>
      {qrData && <img src={qrData} alt="Scan to pair wallet" />}
      <p>Scan with your BSV wallet app</p>
    </div>
  )
}
```

### 3. Use WalletConnectionModal component
```typescript
import { WalletConnectionModal } from '@bsv/wallet-relay/react'

function App() {
  return (
    <>
      <WalletConnectionModal 
        relayUrl="https://relay.example.com"
        onConnect={(client, sessionId) => {
          console.log('Mobile connected, sessionId:', sessionId)
          // Send wallet requests to mobile
        }}
        installUrl="https://desktop.bsvb.tech"
      />
    </>
  )
}
```

### 4. Send wallet RPC call from desktop to mobile
```typescript
import { useWalletRelayClient } from '@bsv/wallet-relay/react'

function sendPayment(client: WalletRelayClient, sessionId: string, desktopToken: string) {
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'createAction',
    params: [{
      description: 'Send payment',
      outputs: [{
        satoshis: 5000,
        lockingScript: '76a914...'
      }]
    }]
  }

  const response = await client.sendRequest(sessionId, request, desktopToken)
  
  if (response.error) {
    console.error('Mobile rejected:', response.error)
  } else {
    console.log('Action created:', response.result.signableTransaction)
  }
}
```

### 5. Mobile wallet implementation (WalletPairingSession)
```typescript
import { WalletPairingSession } from '@bsv/wallet-relay/client'
import { PrivateKey } from '@bsv/sdk'

const session = new WalletPairingSession({
  baseUrl: 'https://relay.example.com',
  identityKey: PrivateKey.fromRandom(),
  wallet: myWalletInstance
})

// Scan desktop QR code to get pairingUri
const { relayUrl, sessionId, sessionKey } = parsePairingUri(scannedQR)

// Pair with desktop
await session.pair({ relayUrl, sessionId, sessionKey })

// Listen for incoming requests
session.onRequest = async (request) => {
  // Forward to local wallet
  const result = await myWallet[request.method](request.params)
  return result
}

// Session handles encryption/decryption automatically
```

### 6. Using Next.js with wallet relay
```typescript
// pages/api/wallet-request.ts
import { WalletRelayClient } from '@bsv/wallet-relay/client'

export default async function handler(req, res) {
  const { sessionId, desktopToken, request } = req.body
  
  const client = new WalletRelayClient({
    baseUrl: process.env.RELAY_URL
  })
  
  const response = await client.sendRequest(sessionId, request, desktopToken)
  
  // Must forward X-Desktop-Token header
  res.setHeader('X-Desktop-Token', desktopToken)
  res.json(response)
}
```

## Key Concepts

- **QR Pairing** — Desktop displays QR code encoding relay URL + session ID. Mobile scans and establishes WebSocket connection.
- **Encrypted Relay** — All wallet requests/responses are AES-256-GCM encrypted. Relay server never sees plaintext.
- **Stateless Sessions** — Each pairing session is isolated. Multiple desktops can pair to same mobile (each gets own session).
- **Desktop Token** — Opaque token returned from `GET /api/session` and required on `POST /api/request/:id`. Ensures only the frontend that created the session can use it, even if sessionId is leaked.
- **Wallet Method Forwarding** — Desktop sends standard JSON-RPC calls (createAction, signAction, getPublicKey, etc.) to mobile wallet. Mobile executes locally and returns result.
- **No Key Export** — Mobile never exports private keys. Desktop sees only signatures, public keys, and action results. Keys never leave mobile.
- **Session Expiry** — Sessions timeout after inactivity (typically 24 hours). Mobile can pair new desktop anytime.

## Dependencies

### Runtime (Peer Deps)
- **`@bsv/sdk`** ^2.0.14 — Cryptography and wallet types
- **`express`** >=4.0.0 (optional) — Web framework for server
- **`ws`** >=8.0.0 (optional) — WebSocket server (required if using WalletRelayService)
- **`qrcode`** >=1.5.0 (optional) — QR code generation (required if using QR components)
- **`react`** >=17.0.0 (optional) — React (required for react exports)

### Dev
- **`jest`** ^30.3.0 — Test runner
- **`ts-jest`** ^29.4.6 — TypeScript support
- **`typescript`** ^5.4.0 — Compiler
- **`tsup`** ^8.0.0 — Bundler

### Other ts-stack packages
- **`@bsv/sdk`** — Cryptography, ProtoWallet, PrivateKey types

## Common Pitfalls / Gotchas

1. **Backend key stability** — `PrivateKey` must be the same across server restarts. Store in env var or secure vault, never generate new key each start.

2. **Missing X-Desktop-Token header** — `POST /api/request/:id` requires `X-Desktop-Token` header. If missing, request is rejected. Browser CORS preflight must allow this header in `allowedHeaders`.

3. **CORS misconfiguration** — If frontend and backend are different origins, CORS headers must be set. Missing `Access-Control-Allow-Credentials` or `Access-Control-Allow-Headers` will cause browser to block requests.

4. **Session expiry during long operations** — If user takes too long to approve on mobile (e.g., verifying on hardware wallet), session may expire. Store desktopToken and allow re-pairing for retry.

5. **QR code data format** — QR must encode a valid pairingUri. If QR library outputs wrong format, mobile won't recognize it. Test with actual mobile wallet before deploying.

6. **WebSocket TLS mismatch** — If frontend is HTTPS but relay is ws:// (not wss://), browser blocks upgrade. Always use wss:// in production.

7. **Relay URL in QR** — The relay URL in QR is public. If relay is on internal network, mobile can't reach it. Use publicly routable URL or tunnel.

8. **Mobile token caching** — Mobile may cache auth tokens. Revoking session on desktop doesn't immediately invalidate mobile connection. Keep sessions short-lived.

9. **Concurrent requests from same desktop** — Each `POST /api/request/:id` is independent. If desktop sends two requests quickly, mobile may process in unexpected order. Add request IDs for sequencing.

10. **React hook dependencies** — `useWalletRelayClient` and `useWalletSession` should be used carefully with dependency arrays. Missing dependencies can cause stale closures.

11. **Scaffold file overwrite** — `npx @bsv/wallet-relay init` does not overwrite existing files. If you run it twice, second run won't re-scaffold.

12. **Mobile origin header** — In split frontend/backend dev setups, set `MOBILE_ORIGIN` env var so mobile device (on different LAN) can reach backend. Don't set in production.

## Spec Conformance

- **ECDH key agreement** — Pairing uses ECDH for shared secret derivation
- **AES-256-GCM** — Authenticated encryption for all message envelopes
- **JSON-RPC 2.0** — Standard format for all wallet method calls
- **WebSocket** — RFC 6455 WebSocket protocol with TLS
- **Base64url** — URL-safe base64 for encoding binary data in URLs

## File Map

- **`src/index.ts`** — Server exports (WalletRelayService, WebSocketRelay, etc.)
- **`src/client.ts`** — Client exports (WalletRelayClient, WalletPairingSession, crypto utils)
- **`src/react.tsx`** — React exports (hooks, components)
- **`src/server/`** — Server implementation (QRSessionManager, WebSocketRelay, handlers)
- **`src/client/`** — Client implementation (WalletRelayClient, WalletPairingSession)
- **`src/react/`** — React components (WalletConnectionModal, QRDisplay, RequestLog, hooks)
- **`src/shared/`** — Shared utilities (crypto, encoding, URI parsing, signature verification)
- **`src/types.ts`** — Shared TypeScript types
- **`bin/init.mjs`** — CLI scaffolding command
- **`template/`** — Template files for scaffold
- **`tests/`** — Test files

## Integration Points

- **@bsv/sdk** — PrivateKey, ProtoWallet, signature verification
- **Express** — HTTP framework for relay server
- **WebSocket (ws)** — Real-time bidirectional communication
- **React** — UI components for pairing flow
- **QRCode library** — Visual QR generation
- Custom wallet apps — Implement `WalletLike` interface to use as relay backend
