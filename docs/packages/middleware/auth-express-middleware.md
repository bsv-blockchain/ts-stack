---
id: pkg-auth-express-middleware
title: '@bsv/auth-express-middleware'
kind: package
domain: middleware
version: '2.3.0'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/auth-express-middleware'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth-express-middleware'
status: stable
tags: [middleware, express, auth, brc-103, brc-104]
---

# @bsv/auth-express-middleware

This source candidate declares SDK peer `^2.8.5 || ^3.0.0`. SDK3 remains
a coordinated proposal; see the [qualification and migration limits](../../guides/identity-did-vc-migration.md)
before adopting it.

Express transport for BRC-103 peer-to-peer mutual authentication over
BRC-104 HTTP. It handles the public handshake, verifies authenticated
application requests, signs responses, and optionally exchanges verifiable
certificates.

## Install

```bash
npm install @bsv/auth-express-middleware @bsv/sdk express
```

Node.js 22 or newer and Express 4.18 or newer are required. The package uses
the application's peer-provided Express runtime and type graph and provides
native ESM and CommonJS entry points with matching declarations.

Version 2.2.4 requires `@bsv/sdk` 2.7.1 or later so the identity assigned to
`req.auth.identityKey` is the identity bound to the verified peer session, not
unsigned BRC-104 transport metadata.

Version 2.2.6 restores bodyless authenticated requests when the Express 4 JSON
parser supplies an empty-object placeholder. HTTP message framing distinguishes
that placeholder from a real JSON `{}` body. Existing clients need no changes;
framed bodies and authentication checks retain their existing semantics.

Version 2.2.7 preserves Express's one-argument response header-map overload.
`res.set({ ...headers })` and authenticated payment challenges work with the
same Express validation, signed headers and wire format. No client migration
is required.

The unpublished 2.3.0 candidate adds optional final response admission after
BRC-104 signing, with native synchronous enqueue, one bounded re-signed replacement
and deadline/disconnect cancellation. Existing routes, peer ranges and wire
representations remain compatible. New guarded routes explicitly install the
boundary described below; ordinary applications need no migration.

Version 2.2.8 requires SDK 2.8.5 and removes middleware header-size and
header-count ceilings. `createAuthMiddleware` configures its Peer with
`maxGeneralPayloadBytes: null`, avoiding an indirect SDK general-message
ceiling for received headers while retaining metadata and signature validation.
Received headers are excluded from `maxRequestBytes`, which still applies to
handshake/plain-data and encoded request bodies. The middleware preserves all
selected header bytes for BRC-104 signing and verification, rather than rejecting
a received payment because of an additional header budget. HTTP server, CDN,
proxy and WAF configuration own transport header limits. Configure those layers
for the largest supported payment proof and validate the complete route.

Malformed or duplicate signed headers, unsafe header values, authentication
failures and invalid signatures still fail validation. Body budgets, timeouts
and replay protection remain separate. Clients consuming larger signed responses
need matching capacity; SDK 2.8.5 raises its header limits by 4x. No BRC100 call,
wire or wallet-data migration is required. Source publication is a separate
protected release step.

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

## Final authenticated response admission

`guardAuthenticatedResponse(res, guard)` is an opt-in boundary for services that
must recheck authorization or output eligibility after asynchronous response
signing. Install it in an authenticated handler before sending the response. It
rejects unauthenticated requests, repeated registration and late registration.

The guard receives an owned candidate containing the authenticated caller,
BRC-104 transport request ID, attempt number, status, response headers and body
bytes. Logical application operation IDs remain separate. Headers include the
BRC-104 authentication metadata and normalized content length; Node may add its
ordinary Date/connection metadata. Signature coverage remains BRC-104's existing
status/body and selected-header rules; ordinary CORS/cache headers do not become
cryptographically signed merely because they appear in this snapshot. It may await
acquisition of the application's durable send fence. While holding that fence,
recheck current authorization and every disclosed target, then call `enqueue()`
synchronously. The callback queues the already signed bytes through Node's native
HTTP response methods. It never signs, waits for a database, or authorizes the
caller itself. A handler-level lock around `res.send()` is insufficient because
signing happens later. The application's writers must use the paired fence,
including writers in other processes.

If the candidate became stale, return a complete replacement with `statusCode`,
`headers` and `body: Uint8Array` without calling `enqueue()`. The middleware
discards the first signed candidate and signs the replacement for the same
request and session. The guard runs again with `attempt: 1`; it must recheck
current access and enqueue this response or fail closed. Only one replacement is
allowed. Its body plus UTF-8 header names and values may total at most 64 KiB, and
its body must also fit the configured response-body limit. Include required CORS,
service capability and error-profile headers explicitly: discarded candidate
headers are not inherited. Never copy confidential candidate headers into a
public error.

Both signing attempts and guard acquisition share the configured response
timeout. Disconnect or timeout aborts the supplied signal, closes the response
and invalidates retained enqueue callbacks. A guard must honor cancellation and
release its own acquired resources. Calling enqueue twice, calling it after the
guard returns, returning without a decision, or failing after bytes were queued
cannot append an unsigned fallback. Failure may close the connection without an
HTTP error; clients should recover through their durable operation protocol.

This mode supports native Node HTTP/1 responses, including HTTPS, with no
compression, deferred encoding, or replacement response/header methods before
or after authentication. Unsupported composition is rejected. Configure the
route outside such middleware and qualify the complete transport stack.
`content-encoding` may be absent or `identity`; transfer framing and exact
content length belong to the native transport. Guarded responses send their
explicit bytes and status without Express's automatic ETag, conditional-response
or body transformations. HEAD, 204, 205 and 304 responses must already have empty
signed bodies. In particular, [HTTP 205 Reset Content](https://www.rfc-editor.org/rfc/rfc9110.html#name-205-reset-content)
prohibits response content; the guard rejects it before signing rather than
letting a client discard signed bytes. Ordinary routes keep their existing Express behavior.

The guard provides the transport boundary, not a root-eviction policy, shared
database, access policy, or index projection adapter. Those components must be
installed and tested together. See the [root coordination guide](../../guides/root-eviction-coordination.md)
and the [compiled interface example](../../guides/compiled-package-examples.md).

## Configuration

```ts
app.use(
  createAuthMiddleware({
    wallet,
    allowUnauthenticated: false,
    sessionManager,
    certificatesToRequest,
    onCertificatesReceived,
    certificateApprovalStore,
    logger,
    logLevel: 'error',
    transportLimits: {
      requestTimeoutMs: 30_000,
      maxPendingRequests: 1_000,
      maxResponseBytes: 8 * 1024 * 1024
    }
  })
)
```

`transportLimits` bounds pending handshakes, verification listeners,
certificate waits, and response-signing state. `maxResponseBytes` also bounds
files passed to `res.sendFile`; oversized application responses fail closed
with a signed `413`. The default is 8 MiB. Operators may set it to `-1` only
when the embedding service enforces an equivalent response budget. Malformed
requests are rejected before state allocation. At capacity, the middleware
fails closed with `503`.

When `onCertificatesReceived` is configured, approval is retained against the
exact validated session nonce and identity. The default bounded approval store
is process-local. Load-balanced services must inject a shared
`certificateApprovalStore` as well as a shared `AsyncSessionManager`; malformed
or unavailable approval-store results fail closed.

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
- Use matching parsers and only flat string fields for URL-encoded bodies;
  lossy nested/array coercions and unsupported nonempty bodies are rejected.
- Do not authorize from `Host`, `Cookie`, forwarding headers, or other metadata
  omitted by the BRC-104 v0.1 signed frame. This subset is deliberate because
  browser and webpage libraries often cannot safely observe those values when
  signing. Pin the authority at the edge and compare required values with exact
  signed `x-bsv-*` or `Authorization` fields. Response authentication likewise
  covers only the declared signed header set, not arbitrary standard response
  headers or the complete browser/proxy context.
- Install one auth wrapper per request path.
- Keep finite timeouts/response sizes/capacity and alert on `408`, `413`, and
  `503`.
- Keep authentication separate from application authorization.
- Do not log raw headers, signatures, certificates, bodies, or wallet objects.
- Public errors are stable and omit internal exception text.

## Public API

Runtime:

- `createAuthMiddleware`
- `ExpressTransport`
- `InMemoryCertificateApprovalStore`

Types:

- `AuthMiddlewareOptions`
- `AuthRequest`
- `AuthTransportLimits`
- `CertificateApprovalStore`
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
