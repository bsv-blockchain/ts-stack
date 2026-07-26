# AGENTS.md — @bsv/auth-express-middleware

## Purpose and protocol boundary

This package is the Express transport for BRC-103 peer-to-peer mutual
authentication over BRC-104 HTTP. It owns handshake dispatch, authenticated
request conversion, signed-response buffering, optional certificate exchange,
and bounded pending transport state. Authorization remains an application
responsibility.

`/.well-known/auth` must remain intentionally reachable so a session can be
established. Do not broaden that exception to path prefixes.

## Public API

- Runtime: `createAuthMiddleware`, `ExpressTransport`
- Types: `AuthMiddlewareOptions`, `AuthRequest`, `AuthTransportLimits`,
  `LogLevel`
- Compatibility: `ExpressTransport.allowAuthenticated` is a deprecated alias
  for `allowUnauthenticated`.

Changing exports, response error codes, signed field ordering, header
normalization, or response wrapping is a public/protocol change.

## Security invariants

- Fail closed unless `allowUnauthenticated` is explicitly true.
- Validate attacker-controlled headers and handshake bodies before allocating
  protocol state.
- Keep every pending listener/handle bounded by `requestTimeoutMs` and
  `maxPendingRequests`; clean timers and SDK listeners on every terminal path.
- Reject simultaneously duplicated request IDs without blocking legitimate
  later handshake phases.
- Do not log auth headers, signatures, certificates, request/response bodies,
  wallet instances, or complete peer objects. Log metadata and stable IDs only.
- Do not return internal wallet, signing, storage, or certificate-handler error
  messages.
- Use a shared `AsyncSessionManager` for horizontally scaled services.
- Use HTTPS; authentication does not provide transport confidentiality.
- Do not impose a hard-coded CORS/CSP policy. Public services must remain
  configurable and may be cross-origin by default.

## Express behavior

- Body parsing runs before auth so the signed representation matches the route
  input.
- Install one auth middleware instance per request path; authenticated
  responses temporarily wrap Express response methods.
- Keep public errors stable and test status/code/description, not internal
  exception text.
- If adding support for another response method, test buffering, signing,
  restoration, failures, and duplicate-send behavior.

## Build and verification

Node.js 22+ is required. `tsdown` emits native ESM, CommonJS, and matching
declarations. The published file allowlist is `dist`, `README.md`, and
`LICENSE.txt`.

Before handing off a change, run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm pack:check
```

Coverage must remain at least 85% lines/statements/functions and 80% branches
over production source. Tests must be deterministic and must not rebuild as a
side effect. `pack:check` must validate the exact tarball in both ESM and
CommonJS consumer probes.

## File map

- `mod.ts` — package entry point and export contract
- `src/index.ts` — transport and middleware factory
- `src/authMiddlewareHelpers.ts` — deterministic request/response encoding
- `src/__tests/` — unit, hardening, and local integration coverage
- `tsdown.config.ts` — ESM/CommonJS build
- `tsconfig.typecheck.json` — strict source and test checking
- `README.md` — user contract and deployment guidance
- `BASELINE.md` — verified repository health snapshot

## Integration points

- `@bsv/sdk` supplies `Peer`, session managers, protocol types, wallet
  interfaces, and `AuthFetch`.
- `@bsv/payment-express-middleware` must run after this package.
- `@bsv/authsocket` is the corresponding WebSocket path.
