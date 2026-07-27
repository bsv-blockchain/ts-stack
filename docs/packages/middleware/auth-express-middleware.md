---
id: pkg-auth-express-middleware
title: '@bsv/auth-express-middleware'
kind: package
domain: middleware
version: '2.1.3'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/auth-express-middleware'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth-express-middleware'
status: stable
tags: [middleware, express, auth, brc-103, brc-104]
---

# @bsv/auth-express-middleware

Express transport for BRC-103 peer-to-peer mutual authentication over
BRC-104 HTTP. It handles the public handshake, verifies authenticated
application requests, signs responses, and optionally exchanges verifiable
certificates.

## Install

```bash
npm install @bsv/auth-express-middleware @bsv/sdk express
```

Node.js 22 or newer is required. The package provides native ESM and CommonJS
entry points with matching declarations.

## Quick start

```ts
import express from 'express'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'

const wallet = new ProtoWallet(PrivateKey.fromRandom())
const app = express()

app.use(express.json())
app.use(createAuthMiddleware({ wallet }))

app.get('/private', (req: AuthRequest, res) => {
  res.json({ identityKey: req.auth?.identityKey })
})
```

Authentication is required by default. `allowUnauthenticated: true` permits
requests without auth and marks them with identity key `unknown`; that value
must never be treated as authorization.

## Configuration

```ts
app.use(
  createAuthMiddleware({
    wallet,
    allowUnauthenticated: false,
    sessionManager,
    certificatesToRequest,
    onCertificatesReceived,
    logger,
    logLevel: 'error',
    transportLimits: {
      requestTimeoutMs: 30_000,
      maxPendingRequests: 1_000
    }
  })
)
```

`transportLimits` bounds pending handshakes, verification listeners,
certificate waits, and response-signing state. Malformed requests are rejected
before state allocation. At capacity, the middleware fails closed with `503`.

The exact `/.well-known/auth` endpoint remains public because it establishes
the session. Similar path prefixes receive normal auth treatment.

## Scaled deployment

The default SDK `SessionManager` is process-local. A load-balanced service must
inject a shared `AsyncSessionManager` so every replica can resolve the same
handshake/session state:

```ts
import type { AsyncSessionManager } from '@bsv/sdk'

app.use(
  createAuthMiddleware({
    wallet,
    sessionManager: sharedSessionManager satisfies AsyncSessionManager
  })
)
```

Use storage with appropriate atomicity, expiry, availability, and encryption.
Sticky routing does not preserve state through process replacement.

## Certificate handling

```ts
app.use(
  createAuthMiddleware({
    wallet,
    certificatesToRequest: {
      certifiers: ['<compressed-certifier-public-key>'],
      types: { '<base64-certificate-type>': ['firstName'] }
    },
    async onCertificatesReceived(senderPublicKey, certificates, req, res, next) {
      await authorizeDisclosedFields(senderPublicKey, certificates)
      next()
    }
  })
)
```

Applications remain responsible for authorization, revocation checks, and
storage of disclosed fields. Callback errors produce generic public responses;
certificate bodies and internal errors are not logged by default or returned.

## Browser and public-service policy

The middleware does not hard-code CORS, CSP, or origin restrictions. Public
services can remain accessible across browser apps, WUI, mobile clients, and
unknown domains by default, while an operator may opt into a configurable
allowlist at the application or edge.

For browsers, handle `OPTIONS` before auth and expose required
`x-bsv-auth-*` headers. Do not combine wildcard origins with credentialed
CORS. CSP is primarily a document policy and is not a substitute for API CORS.

## Security and operations

- Use HTTPS; mutual authentication does not encrypt all HTTP data.
- Parse bodies before auth so signed and routed values match.
- Install one auth wrapper per request path.
- Keep finite timeouts/capacity and alert on `408` and `503`.
- Keep authentication separate from application authorization.
- Do not log raw headers, signatures, certificates, bodies, or wallet objects.
- Public errors are stable and omit internal exception text.

## Public API

Runtime:

- `createAuthMiddleware`
- `ExpressTransport`

Types:

- `AuthMiddlewareOptions`
- `AuthRequest`
- `AuthTransportLimits`
- `LogLevel`

## Related packages

- `@bsv/payment-express-middleware` — authenticated payment gating; runs after
  auth
- `@bsv/authsocket` / `@bsv/authsocket-client` — WebSocket mutual auth
- `@bsv/sdk` — wallet, peer, session, and AuthFetch implementation

## References

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth-express-middleware)
- [npm](https://www.npmjs.com/package/@bsv/auth-express-middleware)
- [BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md)
- [BRC-104](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0104.md)
