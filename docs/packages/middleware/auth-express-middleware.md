---
id: pkg-auth-express-middleware
title: "@bsv/auth-express-middleware"
kind: package
domain: middleware
version: "2.0.5"
source_repo: "bsv-blockchain/auth-express-middleware"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/auth-express-middleware"
repo: "https://github.com/bsv-blockchain/auth-express-middleware"
status: stable
tags: [middleware, express, auth, brc-31]
---

# @bsv/auth-express-middleware

> Express.js middleware implementing BRC-103 peer-to-peer mutual authentication via BRC-104 HTTP transport. Enables cryptographic handshakes between server and client, with optional selective disclosure of verifiable certificates.

## Install

```bash
npm install @bsv/auth-express-middleware
```

## Quick start

```typescript
import express from 'express'
import bodyParser from 'body-parser'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { ProtoWallet } from '@bsv/sdk'
import { PrivateKey } from '@bsv/sdk'

const wallet = new ProtoWallet(new PrivateKey('...', 16))
const authMiddleware = createAuthMiddleware({ wallet, allowUnauthenticated: false })

const app = express()
app.use(bodyParser.json())
app.use(authMiddleware)

app.get('/', (req, res) => {
  if (req.auth && req.auth.identityKey !== 'unknown') {
    res.send(`Hello, authenticated peer: ${req.auth.identityKey}`)
  } else {
    res.status(401).send('Unauthorized')
  }
})

app.listen(3000)
```

## What it provides

- **createAuthMiddleware** — Express middleware factory with BRC-103 authentication
- **AuthRequest** — Extended Request with `.auth` object containing `identityKey`
- **BRC-103 mutual authentication** — Nonce-based challenge-response with signatures
- **BRC-104 HTTP transport** — Custom headers (`x-bsv-auth-*`) for non-general messages
- **Session management** — Tracks nonces per identity; SessionManager interface extensible
- **Certificate exchange** — Optional verifiable certificates during handshake
- **Response wrapping** — Middleware intercepts response methods to sign responses before sending
- **Optional authentication** — `allowUnauthenticated` flag for mixed public/private endpoints

## Common patterns

### Global auth requirement

```typescript
import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'

const app = express()
const authMiddleware = createAuthMiddleware({ wallet })

app.use(express.json())
app.use(authMiddleware)

app.post('/secure-upload', (req, res) => {
  res.send('File uploaded by ' + req.auth.identityKey)
})
```

### Certificate handling

```typescript
function onCertificatesReceived(senderPublicKey, certs, req, res, next) {
  console.log(`Received ${certs.length} certs from ${senderPublicKey}`)
  next()
}

const authMiddleware = createAuthMiddleware({
  wallet,
  certificatesToRequest: {
    certifiers: ['<33-byte-pubkey-hex>'],
    types: {
      'age-verification': ['dateOfBirth', 'country']
    }
  },
  onCertificatesReceived
})

app.use(express.json())
app.use(authMiddleware)
```

### Per-route protection

```typescript
app.post('/secure-endpoint', createAuthMiddleware({ wallet }), (req, res) => {
  res.send('Request authenticated via BRC-103: ' + req.auth.identityKey)
})
```

## Key concepts

- **BRC-103 mutual authentication** — Nonce-based challenge-response with signatures
- **BRC-104 HTTP transport** — Uses custom headers and `/.well-known/auth` endpoint
- **General vs non-general messages** — Non-general for handshake, general for authenticated app requests
- **Nonce binding** — Each request/response pair bound to server-generated nonce; prevents replay attacks
- **Session management** — Tracks nonces per identity; SessionManager interface extensible
- **Certificate exchange** — Optional verifiable certificates during handshake
- **Response wrapping** — Middleware intercepts response methods to sign responses before sending

## When to use this

- Protecting REST API endpoints with Bitcoin signature authentication
- Building servers that verify user identity without passwords
- Implementing APIs where requests prove identity cryptographically
- Replacing JWT/session auth with signature-based auth
- Building peer-to-peer APIs with mutual authentication

## When NOT to use this

- WebSocket authentication — use `@bsv/authsocket` instead
- Traditional password/session auth — use passport.js
- Public APIs without authentication — skip this middleware
- Bearer token auth — use standard OAuth middleware

## Spec conformance

- **BRC-103** (Peer-to-Peer Mutual Authentication): Full handshake, nonce exchange, signature verification, optional certificate exchange
- **BRC-104** (HTTP Transport for BRC-103): Uses custom headers and `/.well-known/auth` endpoint
- **BRC-100** (Wallet interface): Leverages standard wallet signing/verification interface

## Common pitfalls

1. **Must run before routes** — Place auth middleware early in middleware stack
2. **Wallet must be BRC-100 compatible** — Needs `sign()` and `verify()` methods
3. **allowUnauthenticated changes behavior** — If false (default), unauthenticated requests get 401; if true, they pass with identityKey='unknown'
4. **Response wrapping side effects** — Middleware modifies Express response object; don't install twice on same app
5. **Certificate request timeout** — If requesting certificates and client doesn't respond in 30 seconds, times out with 408
6. **HTTPS recommended** — BRC-103 authenticates but doesn't encrypt; run over TLS for confidentiality

## Related packages

- **@bsv/payment-express-middleware** — Often stacked after this for monetized APIs
- **@bsv/authsocket** / **@bsv/authsocket-client** — Parallel BRC-103 implementation for WebSockets
- **@bsv/paymail** — Can combine with Paymail for authenticated capability discovery

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/auth-express-middleware/)
- [Source on GitHub](https://github.com/bsv-blockchain/auth-express-middleware)
- [npm](https://www.npmjs.com/package/@bsv/auth-express-middleware)
