---
id: wallet-relay
title: "@bsv/wallet-relay"
kind: package
domain: wallet
npm: "@bsv/wallet-relay"
version: "0.1.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["wallet", "relay"]
github_repo: "https://github.com/bsv-blockchain/ts-stack"
---

# @bsv/wallet-relay

Enables mobile-to-desktop wallet pairing via QR codes and encrypted WebSocket tunnels. A web app (desktop browser) shows a QR code; user scans with their mobile BSV wallet; all wallet operations (signing, key retrieval, etc.) are proxied over HTTPS+WSS relay servers to the mobile without exposing keys or trust chains to the desktop. Provides both the relay server infrastructure (Node.js) and React frontend components for web apps to add "Connect Mobile Wallet" functionality.

## Install

```bash
npm install @bsv/wallet-relay
```

## Quick start

### Set up relay server (Express + Node.js)

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

### Create session and get QR code (frontend React)

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

## What it provides

### Server-Side (Node.js)

- **WalletRelayService** — All-in-one relay server; auto-registers REST routes (`GET /api/session`, `POST /api/request/:id`) and WebSocket endpoint
- **QRSessionManager** — Session lifecycle management, status tracking, cleanup
- **WebSocketRelay** — WebSocket server with message routing, topic validation, token auth
- **WalletRequestHandler** — Converts JSON-RPC calls to wallet method invocations

### Client-Side (Browser)

- **WalletRelayClient** — Direct HTTP/WebSocket client for session management and RPC calls
- **useWalletRelayClient** — React hook wrapping client
- **useWalletSession** — Hook for session state management
- **WalletConnectionModal** — Pre-built UI component for QR pairing flow
- **QRDisplay** — Standalone QR code display component
- **RequestLog** — UI for displaying pending/completed RPC requests

### Shared Utilities

- **Encryption** — `encryptEnvelope()`, `decryptEnvelope()` for AES-256-GCM authenticated encryption
- **URI handling** — `buildPairingUri()`, `parsePairingUri()` for QR encoding
- **Signature verification** — `verifyPairingSignature()` for ECDSA signature validation
- **Encoding** — `bytesToBase64url()`, `base64urlToBytes()` for URL-safe binary

### CLI Scaffolding

- **npx @bsv/wallet-relay init** — Command to scaffold Express backend + React frontend

## Common patterns

### Use WalletConnectionModal component

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

### Send wallet RPC call from desktop to mobile

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

### Mobile wallet implementation

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
```

## Key concepts

- **QR Pairing** — Desktop displays QR code encoding relay URL + session ID. Mobile scans and establishes WebSocket connection.
- **Encrypted Relay** — All wallet requests/responses are AES-256-GCM encrypted. Relay server never sees plaintext.
- **Stateless Sessions** — Each pairing session is isolated. Multiple desktops can pair to same mobile (each gets own session).
- **Desktop Token** — Opaque token returned from `GET /api/session` and required on `POST /api/request/:id`. Ensures only the frontend that created the session can use it.
- **Wallet Method Forwarding** — Desktop sends standard JSON-RPC calls (createAction, signAction, getPublicKey, etc.) to mobile wallet.
- **No Key Export** — Mobile never exports private keys. Desktop sees only signatures, public keys, and action results.
- **Session Expiry** — Sessions timeout after inactivity (typically 24 hours). Mobile can pair new desktop anytime.

## When to use this

- You're building a web app that needs to integrate with mobile wallets
- You want mobile users to pair with desktop for signing without downloading software
- You need secure wallet proxying over untrusted networks
- You're building a cross-device wallet experience

## When NOT to use this

- Use [@bsv/wallet-toolbox](./wallet-toolbox.md) directly if you need local wallet without pairing
- Use [@bsv/sdk](../sdk/bsv-sdk.md) if you only need transaction building, not wallet integration

## Spec conformance

- **ECDH key agreement** — Pairing uses ECDH for shared secret derivation
- **AES-256-GCM** — Authenticated encryption for all message envelopes
- **JSON-RPC 2.0** — Standard format for all wallet method calls
- **WebSocket** — RFC 6455 WebSocket protocol with TLS
- **Base64url** — URL-safe base64 for encoding binary data in URLs

## Common pitfalls

> **Backend key stability** — `PrivateKey` must be the same across server restarts. Store in env var or secure vault, never generate new key each start.

> **Missing X-Desktop-Token header** — `POST /api/request/:id` requires `X-Desktop-Token` header. Browser CORS preflight must allow this header in `allowedHeaders`.

> **CORS misconfiguration** — If frontend and backend are different origins, CORS headers must be set. Missing `Access-Control-Allow-Credentials` or `Access-Control-Allow-Headers` will cause browser to block requests.

> **WebSocket TLS mismatch** — If frontend is HTTPS but relay is ws:// (not wss://), browser blocks upgrade. Always use wss:// in production.

> **Relay URL in QR** — The relay URL in QR is public. If relay is on internal network, mobile can't reach it. Use publicly routable URL or tunnel.

## Related packages

- [@bsv/sdk](../sdk/bsv-sdk.md) — Cryptographic primitives and ProtoWallet
- [@bsv/wallet-toolbox](./wallet-toolbox.md) — Wallet implementation for backend
- [@bsv/btms](./btms.md) — Token protocol integration

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/wallet-relay/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack)
- [npm](https://www.npmjs.com/package/@bsv/wallet-relay)
