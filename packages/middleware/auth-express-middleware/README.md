# @bsv/auth-express-middleware

Express middleware for BRC-103 peer-to-peer mutual authentication over the
BRC-104 HTTP transport. It handles the public handshake endpoint, verifies
authenticated application requests, signs responses, and optionally exchanges
verifiable certificates.

## Requirements

- Node.js 22 or newer
- Express 5
- A BRC-100 `WalletInterface`

The package ships native ESM and CommonJS entry points with declarations for
both module systems.

## Install

```bash
npm install @bsv/auth-express-middleware @bsv/sdk express
```

## Basic use

Parse the request body before authentication so the signed payload contains
the same value your route receives:

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

Authentication is required by default. Requests without BRC-103/104
authentication receive `401`. With `allowUnauthenticated: true`, they continue
with `req.auth.identityKey === 'unknown'`.

The exact `/.well-known/auth` path is always reachable through this middleware
because it establishes the session used by protected routes. Similar prefixes
such as `/.well-known/auth/extra` are not treated as handshake traffic.

## Options

```ts
const auth = createAuthMiddleware({
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
```

- `wallet` is required and must implement the BRC-100 wallet interface.
- `allowUnauthenticated` defaults to `false`.
- `sessionManager` accepts the SDK's `SessionManager` or an
  `AsyncSessionManager`.
- `certificatesToRequest` asks a peer for selected certificate fields.
- `onCertificatesReceived` may be synchronous or asynchronous. It receives
  `(senderPublicKey, certificates, req, res, next)`. Calling `next` more than
  once has no effect.
- `logger` and `logLevel` enable structured lifecycle logs. Authentication
  headers, certificate bodies, signatures, response bodies, and wallet objects
  are not logged.
- `transportLimits.requestTimeoutMs` bounds handshake, verification,
  certificate, and response-signing state. It defaults to 30 seconds.
- `transportLimits.maxPendingRequests` bounds per-process pending protocol
  state. It defaults to 1,000 and fails closed with `503` at capacity.

Invalid option types fail during startup.

## Horizontally scaled services

The default `SessionManager` is process-local. Use a shared
`AsyncSessionManager` when a load balancer can route the handshake and the
authenticated request to different instances:

```ts
import type { AsyncSessionManager } from '@bsv/sdk'

const sessionManager: AsyncSessionManager = {
  async addSession(session) {
    await sessions.put(session.sessionNonce, session)
  },
  async updateSession(session) {
    await sessions.put(session.sessionNonce, session)
  },
  async getSession(identifier) {
    return await sessions.get(identifier)
  },
  async removeSession(session) {
    await sessions.delete(session.sessionNonce)
  },
  async hasSession(identifier) {
    return (await sessions.get(identifier)) !== undefined
  }
}

app.use(createAuthMiddleware({ wallet, sessionManager }))
```

The backing store must preserve the SDK's session semantics and should use
appropriate atomicity, expiry, availability, and encryption controls. Sticky
routing is not a substitute for shared state when instances can be replaced.

## Certificates

```ts
app.use(
  createAuthMiddleware({
    wallet,
    certificatesToRequest: {
      certifiers: ['<compressed-certifier-public-key>'],
      types: {
        '<base64-certificate-type>': ['firstName']
      }
    },
    async onCertificatesReceived(senderPublicKey, certificates, req, res, next) {
      await authorizeDisclosedFields(senderPublicKey, certificates)
      next()
    }
  })
)
```

The application remains responsible for authorization policy, certificate
revocation checks, and safe storage of disclosed data. A missing required
certificate fails with a stable public error. Internal wallet, signing, and
certificate-handler errors are logged only through the optional logger and are
not returned to callers.

## Public services, CORS, and CSP

This package does not impose CORS, CSP, or an origin allowlist. That is
intentional: auth endpoints may serve browser apps, WUI, mobile clients, and
other callers across many domains. Configure those policies at the application
or edge layer:

- Keep public-service access available by default when that is the service
  contract.
- Offer an operator-configured origin allowlist as an opt-in restriction.
- Never combine `Access-Control-Allow-Origin: *` with credentialed CORS.
- Expose the required `x-bsv-auth-*` response headers to browser clients.
- Handle `OPTIONS` before authentication when browser preflight is supported.
- Treat CSP as a browser-document policy; API responses generally need CORS
  and transport controls instead.

Do not hard-code a deployment-specific domain list in this middleware.

## Error behavior

Public errors are deliberately stable and do not include internal exception
messages:

| Status | Code                               | Meaning                                         |
| ------ | ---------------------------------- | ----------------------------------------------- |
| 400    | `ERR_AUTH_MALFORMED`               | Invalid handshake or auth headers               |
| 400    | `ERR_CERTIFICATES_REQUIRED`        | Required certificates were not supplied         |
| 401    | `UNAUTHORIZED` / `ERR_AUTH_FAILED` | Authentication was absent or failed             |
| 408    | `ERR_AUTH_TIMEOUT`                 | A bounded protocol step timed out               |
| 500    | `ERR_INTERNAL_SERVER_ERROR`        | Internal auth processing failed                 |
| 500    | `ERR_RESPONSE_SIGNING_FAILED`      | The authenticated response could not be signed  |
| 503    | `ERR_AUTH_CAPACITY`                | Pending-auth state reached its configured limit |

## Security notes

- Use HTTPS. Mutual authentication provides integrity and identity, not
  confidentiality for all HTTP metadata and content.
- Install the middleware once per request path; response methods are
  temporarily wrapped while an authenticated response is signed.
- Do not trust `req.auth.identityKey === 'unknown'` as authorization.
- Use shared session state for multi-instance deployments.
- Keep timeouts and capacity limits finite and monitor `408`/`503` rates.
- Validate authorization separately after identity authentication.
- Keep request body limits and normal Express hardening in place.

## API

Runtime exports:

- `createAuthMiddleware`
- `ExpressTransport`

Type exports:

- `AuthMiddlewareOptions`
- `AuthRequest`
- `AuthTransportLimits`
- `LogLevel`

See [API.md](./API.md) for generated signatures.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm pack:check
```

`pack:check` builds and validates the exact npm tarball in ESM and CommonJS
consumer probes. Tests do not rebuild the package as a side effect.

## Specifications

- [BRC-103: Peer-to-Peer Mutual Authentication](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md)
- [BRC-104: HTTP Transport for BRC-103](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0104.md)

## License

See [LICENSE.txt](./LICENSE.txt).
