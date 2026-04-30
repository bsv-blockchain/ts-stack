---
id: spec-brc-31-auth
title: BRC-31 Mutual Authentication Handshake
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "auth", "brc-103", "brc-31"]
---

# BRC-31 Mutual Authentication Handshake

> BRC-31 (implemented via BRC-103 `Peer` + BRC-104 HTTP transport) enables cryptographic handshakes between client and server. Both parties prove identity using ECDSA signatures, establishing a forward-secret session where every message is signed and verified. No shared passwords or certificates required—only identity public keys.

## Interactive spec

<AsyncApiEmbed slug="brc31" />

## At a glance

| Field | Value |
|---|---|
| Format | AsyncAPI 3.0 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/auth-express-middleware, @bsv/authsocket |

## What problem this solves

**Verifiable peer identity without PKI infrastructure**. Traditional APIs use API keys or JWT tokens, which are single-factor and don't prove who is calling. BRC-31 uses ECDSA signatures to prove the caller's identity: only the holder of the private key can generate valid signatures. This works peer-to-peer (no trusted CA) and is quantum-resistant.

**Replay attack prevention**. The handshake uses nonces (one-time values) bound to each request. An attacker cannot replay a signature from one request to another because the request ID and timestamp are part of the signed payload. This prevents man-in-the-middle replay attacks.

**Certificate exchange**. The handshake optionally requests verifiable certificates (e.g., age verification, credential proofs) that the client provides. The server can validate these against known certifiers, enabling selective disclosure (e.g., "prove you're over 18" without revealing your actual birthdate).

## Protocol overview

**Two-phase handshake** (followed by authenticated requests):

**Phase 1 — Initial Exchange (non-general)**

1. **Client → Server** `POST /.well-known/auth` with `initialRequest` message
   - Client's public key in `x-bsv-auth-identity-key` header
   - Client's nonce in `x-bsv-auth-nonce` header
   - Client signature over the nonce in `x-bsv-auth-signature` header

2. **Server → Server** (validates nonce, generates its own nonce)
   - Returns 200 with `initialResponse` message
   - Server's public key in `x-bsv-auth-identity-key` response header
   - Server's nonce in `x-bsv-auth-nonce` response header
   - Server signature (covering client's nonce and server's nonce) in `x-bsv-auth-signature` header
   - If requesting certificates: `x-bsv-auth-requested-certificates` header with certificate types

3. **Client → Server** (if server requested certificates)
   - `POST /.well-known/auth` with certificate payload
   - Server waits up to 30 seconds; if timeout returns 408

**Phase 2 — General Authenticated Requests**

After handshake succeeds, every request/response carries:

- **Request headers**:
  - `x-bsv-auth-version` — protocol version
  - `x-bsv-auth-identity-key` — client's public key
  - `x-bsv-auth-nonce` — server's last nonce
  - `x-bsv-auth-your-nonce` — client's last nonce
  - `x-bsv-auth-request-id` — fresh random 32-byte value
  - `x-bsv-auth-signature` — ECDSA signature over `requestId || method || path || headers || body`

- **Response headers** (same pattern, server signs):
  - `x-bsv-auth-identity-key`, `x-bsv-auth-nonce`, `x-bsv-auth-your-nonce`, `x-bsv-auth-request-id`, `x-bsv-auth-signature`
  - Signature covers `requestId || statusCode || headers || body`

## Key types / endpoints

| Channel | Direction | Message Type | Purpose |
|---------|-----------|--------------|---------|
| `/.well-known/auth` | Request | `initialRequest` | Client initiates handshake with nonce |
| `/.well-known/auth` | Response | `initialResponse` | Server validates, responds with nonce + signature |
| `/.well-known/auth` | Request | `certificatePayload` | Client provides certificates if server requested |
| Any route | Request | `general` | Authenticated application request (after handshake) |
| Any route | Response | `general` | Authenticated application response |

## Example: Express middleware handshake

```typescript
import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'

// 1. Create wallet for signing/verifying
const wallet = new ProtoWallet(PrivateKey.fromHex(process.env.SERVER_PRIVATE_KEY!))

// 2. Create auth middleware
const authMiddleware = createAuthMiddleware({
  wallet,
  allowUnauthenticated: false  // Reject unauthenticated requests with 401
})

const app = express()
app.use(express.json())
app.use(authMiddleware)  // Install middleware early

// 3. Routes now have req.auth.identityKey set to client's public key
app.get('/protected', (req, res) => {
  res.json({
    message: `Hello, ${req.auth.identityKey}`,
    authenticated: true
  })
})

app.listen(3000)
```

Client-side (using `AuthFetch` from @bsv/sdk):

```typescript
import { AuthFetch } from '@bsv/sdk'

const authFetch = new AuthFetch(walletClient)

// Handshake + signature happen transparently
const response = await authFetch.fetch('https://server.com/protected', {
  method: 'GET'
})

const data = await response.json()
console.log(data.message)  // "Hello, 025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366"
```

## Example: WebSocket with AuthSocket

```typescript
import http from 'http'
import { AuthSocketServer } from '@bsv/authsocket'

const server = http.createServer()

// 1. Wrap with BRC-103 authentication
const io = new AuthSocketServer(server, {
  wallet: serverWallet,
  cors: { origin: '*' }
})

// 2. Listen for authenticated connections
io.on('connection', (socket) => {
  console.log('Authenticated:', socket.id)
  
  // All messages from this socket are auto-verified
  socket.on('chatMessage', (msg) => {
    console.log('Message verified:', msg)
  })
})

server.listen(3000)
```

Client connects with BRC-103 handshake; all WebSocket messages are signed/verified.

## Conformance vectors

BRC-31-related portable coverage currently lives in `conformance/vectors/messaging/brc31/authrite-signature.json`:

- Nonce generation and freshness
- Signature verification with ECDSA
- Replay attack prevention (nonce reuse detection)
- Request ID binding to headers and body
- Certificate request/response flow
- Session establishment and timeout handling

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/auth-express-middleware | Express.js middleware for HTTP BRC-31 authentication; intercepts response methods to sign responses |
| @bsv/authsocket | Socket.IO wrapper adding BRC-31 authentication to WebSocket connections |
| @bsv/sdk | `Peer` and `Transport` abstractions; `AuthFetch` client implementation |

## Related specs

- [BRC-100 Wallet](./brc-100-wallet.md) — Wallet interface (provides identity keys and signing)
- [BRC-103 Peer Auth](https://github.com/bitcoin-sv/BRCs/blob/master/auth/0103.md) — Underlying peer-to-peer mutual auth primitives
- [BRC-104 HTTP Transport](https://github.com/bitcoin-sv/BRCs/blob/master/auth/0104.md) — HTTP header protocol for BRC-103
- [BRC-121 / 402](./brc-121-402.md) — Often stacked after BRC-31 for monetized endpoints

## Spec artifact

[brc31-handshake.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/auth/brc31-handshake.yaml)
