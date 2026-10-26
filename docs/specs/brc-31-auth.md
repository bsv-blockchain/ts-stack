---
id: spec-brc-31-auth
title: BRC-31 Mutual Authentication Handshake
kind: spec
version: '1.0.0'
last_updated: '2026-04-28'
last_verified: '2026-04-28'
status: stable
tags: ['spec', 'auth', 'brc-103', 'brc-31']
---

# BRC-103 Mutual Authentication Handshake

> This page's historical path retains “brc-31”, but the protocol documented
> here is BRC-103 `Peer` over the BRC-104 HTTP transport. BRC-31 Authrite is a
> separate protocol. BRC-103 enables cryptographic handshakes between client
> and server. Both parties
> prove control of identity keys using signatures, and authenticated
> application messages are signed and verified. No shared password is
> required.

## Interactive spec

<AsyncApiEmbed slug="brc31" />

## At a glance

| Field           | Value                                         |
| --------------- | --------------------------------------------- |
| Format          | AsyncAPI 3.0                                  |
| Version         | 1.0.0                                         |
| Status          | stable                                        |
| Implementations | @bsv/auth-express-middleware, @bsv/authsocket |

## What problem this solves

**Verifiable peer identity without a conventional account token**. BRC-31
uses signatures to prove control of an identity private key. Certificate trust
and application authorization remain separate concerns. ECDSA is not
post-quantum cryptography.

**Replay resistance with session state**. Session nonces and a fresh
32-byte request ID are bound into signed request/response payloads. The SDK
session manager must preserve and validate that state; a nonce string alone is
not an expiring single-use store. The signed HTTP payload does not introduce a
separate timestamp field.

**Certificate exchange**. The handshake optionally requests verifiable certificates (e.g., age verification, credential proofs) that the client provides. The server can validate these against known certifiers, enabling selective disclosure (e.g., "prove you're over 18" without revealing your actual birthdate).

## Protocol overview

**Two-phase handshake** (followed by authenticated requests):

**Phase 1 — Initial Exchange (non-general)**

1. **Client → Server** `POST /.well-known/auth` with `initialRequest` message
   - JSON contains `version`, `messageType`, `identityKey`,
     `initialNonce`, and `requestedCertificates`
   - The v0.1 initial request is unsigned and uses no general-message auth headers

2. **Server → Client** (validates nonce, generates its own nonce)
   - Returns 200 with a JSON `initialResponse` message
   - Response includes the server identity, both nonces, and a signature over
     the nonce pair
   - Optional certificates and certificate requests are JSON members

3. **Client → Server** (if server requested certificates)
   - `POST /.well-known/auth` with certificate payload
   - Server waits up to 30 seconds; if timeout returns 408

The v0.1 initial-response signature does not bind its optional certificates or
certificate request. Built-in wallet proving encrypts revealed keys to the
destination identity, but certificate callbacks must treat an initial sender
identity as claimed and must not disclose plaintext or authorize side effects.
The requested set can be modified in transit. Every authentication and
authorization decision must therefore be based on the certificates and fields
actually disclosed and validated, never on what the request appears to have
asked for. Use a signed post-handshake request when request integrity itself is
needed, while still evaluating only the resulting disclosures.

`RequestedCertificateSet` is an allowlist, not a completeness assertion.
Validation does not prove that every listed type or field was supplied.
The protocol deliberately lets each party choose what to request, what to
provide, and how much to disclose. The library facilitates and standardizes
that selective revelation; it does not declare any claims sufficient at the
application level. Applications must inspect the actual validated certificates
and decrypted fields and terminate or constrain the session, access, or
operation whenever they do not satisfy local policy.

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

The BRC-104 v0.1 request frame signs the method, pathname, query, body, and
only the declared header subset: non-auth `x-bsv-*`, normalized `content-type`,
and `Authorization`. It does not sign scheme/authority (`Host`), cookies,
forwarding headers, or arbitrary standard headers. Pin the expected authority
at a trusted edge; never select a tenant or grant authority from omitted
metadata; and carry required application authorization inputs in exact signed
fields. Distinct virtual security principals should use distinct server
identity keys. This signed subset is deliberate: application libraries often
run inside webpages and browsers where scheme, authority, cookie, forwarding,
and response-routing metadata is unavailable or not safely observable when the
signature is created. The response frame likewise signs only non-auth
`x-bsv-*` and `Authorization`, so an authenticated decision must not exist
solely in an unsigned redirect, cookie, content type, or other standard
response header. A valid protocol signature authenticates only the documented
subset, not the complete browser or proxy request context.

## Key types / endpoints

| Channel             | Direction | Message Type         | Purpose                                             |
| ------------------- | --------- | -------------------- | --------------------------------------------------- |
| `/.well-known/auth` | Request   | `initialRequest`     | Client initiates handshake with nonce               |
| `/.well-known/auth` | Response  | `initialResponse`    | Server validates, responds with nonce + signature   |
| `/.well-known/auth` | Request   | `certificatePayload` | Client provides certificates if server requested    |
| Any route           | Request   | `general`            | Authenticated application request (after handshake) |
| Any route           | Response  | `general`            | Authenticated application response                  |

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
  allowUnauthenticated: false // Reject unauthenticated requests with 401
})

const app = express()
app.use(express.json())
app.use(authMiddleware) // Install middleware early

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
console.log(data.message) // "Hello, 025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366"
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
io.on('connection', socket => {
  console.log('Authenticated:', socket.id)

  // All messages from this socket are auto-verified
  socket.on('chatMessage', msg => {
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

| Package                      | Notes                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| @bsv/auth-express-middleware | Express.js middleware for HTTP BRC-31 authentication; intercepts response methods to sign responses |
| @bsv/authsocket              | Socket.IO wrapper adding BRC-31 authentication to WebSocket connections                             |
| @bsv/sdk                     | `Peer` and `Transport` abstractions; `AuthFetch` client implementation                              |

## Related specs

- [BRC-100 Wallet](./brc-100-wallet.md) — Wallet interface (provides identity keys and signing)
- [BRC-103 Peer Auth](https://github.com/bitcoin-sv/BRCs/blob/master/auth/0103.md) — Underlying peer-to-peer mutual auth primitives
- [BRC-104 HTTP Transport](https://github.com/bitcoin-sv/BRCs/blob/master/auth/0104.md) — HTTP header protocol for BRC-103
- [BRC-121 / 402](./brc-121-402.md) — Often stacked after BRC-31 for monetized endpoints

## Spec artifact

[brc103-mutual-auth.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/auth/brc103-mutual-auth.yaml)
