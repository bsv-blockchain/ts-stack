# Message Box Server Maintainer Guide

## Scope

`@bsv/messagebox-server` is the private deployable service behind
`@bsv/message-box-client`. It stores encrypted messages, enforces
recipient-controlled delivery permissions and fees, authenticates HTTP and
WebSocket peers with BRC-103, and optionally delivers Firebase notifications.
It is shipped as a container, not a public npm artifact.

## Service contract

Public pre-auth routes:

- `GET /health` — process liveness
- `GET /ready` — non-sensitive database readiness
- `GET /docs` and `GET /openapi.json` — runtime documentation

Authenticated routes:

- `POST /sendMessage` — one to 100 recipients
- `POST /listMessages` — deterministic pages of at most 1,000 records
- `POST /acknowledgeMessage` — at most 1,000 IDs
- `POST /registerDevice` — an FCM token cannot be reassigned across identities
- `GET /devices` — redacted, bounded pagination
- `POST /permissions/set`
- `GET /permissions/get`
- `GET /permissions/list` — bounded pagination
- `GET /permissions/quote` — one to 100 recipients with bounded concurrency

WebSocket rooms are `{identityKey}-{messageBox}`. Identity comes from the
authenticated transport, never solely from a payload claim. WebSocket sends
reuse the complete HTTP validation, permission, fee, payment, duplicate, and
persistence path.

## Security and availability invariants

- Message Box is a public protocol service. Default CORS is credential-free
  wildcard access, including opaque `Origin: null`. Operators may explicitly
  select an exact allowlist or disable cross-origin browser access.
- Do not use CORS or CSP as authentication. Preserve BRC-103 authentication,
  recipient ownership, end-to-end encryption, permission/payment policy,
  bounded work, and rate limits.
- Permission/fee storage failures fail closed. They must never become free or
  allowed delivery.
- Implicit default permission reads do not write rows. Explicit box-wide and
  sender-specific permissions are uniquely keyed by normalized sender scope.
- Log no service private keys, complete FCM tokens, auth material, payment
  payloads, or plaintext message bodies.
- Database migrations, wallet/auth initialization, and WebSocket setup finish
  before the process listens. A failed prerequisite is a failed process.
- `PORT` takes precedence over compatibility fallback `HTTP_PORT`; the default
  is 8080. The container serves Node HTTP/WebSocket traffic directly. A trusted
  platform ingress may sit in front of it.
- Horizontal WebSocket routing and the default rate-limit store are
  process-local. Multiple replicas require sticky routing or an authenticated
  shared broker/store.

## Shared policy files

`src/security/edgePolicy.ts` and `src/security/rateLimitPolicy.ts` are
byte-for-byte synchronized from the canonical WAB implementations. Do not make
message-box-only edits or reformat them. Change the canonical policy and run:

```bash
pnpm sync:service-edge-policy
pnpm sync:service-rate-limit-policy
```

They are intentionally excluded from this service's local Prettier pass.

## File map

- `src/index.ts` — standalone migration/init/listen lifecycle
- `src/app.ts` — Express, auth, public edge policy, and route wiring
- `src/compose.ts`, `src/context.ts`, `src/runtimeDeps.ts` — embeddable API and
  dependency binding
- `src/routes/` — HTTP handlers
- `src/security/` — shared edge/rate policy and Message Box WebSocket policy
- `src/migrations/` — Knex schema history
- `src/config/firebase.ts` — optional Firebase initialization
- `src/telemetry.ts`, `src/utils/logger.ts` — observability
- `Dockerfile` — digest-pinned Node 24 build/runtime
- `README.md`, `DEPLOYING.md` — developer and operator documentation
- `specs/messaging/message-box-http.yaml` — reviewed source contract

## Required checks

From `infra/message-box-server`:

```bash
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run typecheck
npm run format:check
npm run lint
npm test
npm run test:coverage
npm run build
npm audit --audit-level=high
```

From the repository root, also run synchronized-policy, OpenAPI/codegen,
documentation, repository-health, and Linux container CI gates. Do not rely on
a macOS image build as Linux/amd64 release evidence.

## Deployment

Use the repository's git-triggered release/deployment path and immutable image
evidence. Keep CORS mode, trusted proxy hops, database and wallet endpoints,
Firebase credentials, OTLP settings, probes, rollback, and migration evidence
under operator control. Never commit secrets. Do not bump or publish an npm
version as part of service maintenance.
