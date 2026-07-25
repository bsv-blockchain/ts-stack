---
id: infra-service-edge-security
title: "Public Service Edge Security"
kind: reference
version: "1.0.0"
last_updated: "2026-07-25"
last_verified: "2026-07-25"
review_cadence_days: 30
status: stable
tags: [infrastructure, security, cors, rate-limits, authentication, operations]
---

# Public Service Edge Security

This page is the security and resource-control inventory for the HTTP and
WebSocket services maintained in this repository. It covers the deployed
infrastructure entrypoints and the reusable `OverlayExpress`,
`StorageServer`, `AdminServer`, and `ChaintracksService` server classes.

The services are public protocols. Web apps on previously unknown domains,
wallet UIs, mobile clients, server processes, and command-line clients must all
be able to connect. Browser reachability is therefore public by default, while
authorization remains enforced by protocol authentication, payment policy,
per-identity quotas, input validation, and endpoint ownership rules.

## Shared edge contract

Every maintained service installs controls in this order:

1. explicit reverse-proxy trust, where applicable;
2. security response headers and removal of `X-Powered-By`;
3. CORS policy;
4. a per-process in-flight request ceiling;
5. a pre-authentication IP rate limit on state-changing work;
6. endpoint-specific, bounded body parsing;
7. BRC-103 or administrative authentication;
8. a post-authentication identity rate limit;
9. payment middleware where the endpoint is monetized; and
10. route validation and a stable, non-sensitive error envelope.

The shared implementation is authored at
`infra/wab/src/security/edgePolicy.ts` and synchronized to every deployable
context with:

```sh
pnpm sync:service-edge-policy
pnpm health:check
```

CI fails if a synchronized copy drifts.

### CORS modes

`<PREFIX>_CORS_MODE` accepts:

| Mode | Behavior |
|---|---|
| `public` | Default. Browser origins, including opaque `null` origins from sandboxed/file/mobile-webview contexts, receive `Access-Control-Allow-Origin: *`. Cookie credentials are never enabled. |
| `allowlist` | Only exact origins in `<PREFIX>_CORS_ALLOWED_ORIGINS` are accepted. Responses echo that origin and set `Vary: Origin`. |
| `disabled` | Requests without `Origin` continue; cross-origin browser requests receive `403 ERR_ORIGIN_NOT_ALLOWED`. |

Setting an origin list without a mode selects `allowlist` for compatibility.
Wildcard, opaque `null`, credentialed, path-bearing, query-bearing, and
fragment-bearing allowlist entries fail startup. A shared `CORS_MODE` and
`CORS_ALLOWED_ORIGINS` may be used as fallbacks.

Public CORS does not make a protected endpoint anonymous. It only lets browser
JavaScript attempt the same signed or token-authenticated protocol call that a
mobile or server client can attempt. No service in this inventory uses ambient
browser cookies as its authorization boundary.

### CSP and other response headers

API responses use `nosniff`, deny framing, no-referrer, a restrictive
permissions policy, an opener policy, a public-compatible
`Cross-Origin-Resource-Policy: cross-origin`, and HSTS when Express has
established a secure request through the configured proxy trust chain. Raw
`X-Forwarded-Proto` is not trusted directly.

These headers do not replace protocol authentication, and CSP does not decide
which browser origins may call an API. Deployments can override the defaults
without patching source by setting the service-prefixed variables below.
Deployment variables take precedence over programmatic defaults; omit them to
use the library configuration. The value `disabled` omits headers that support
omission.

| Variable | Accepted values |
|---|---|
| `<PREFIX>_CONTENT_SECURITY_POLICY` | A single-line CSP, or `disabled`. |
| `<PREFIX>_CROSS_ORIGIN_RESOURCE_POLICY` | `cross-origin` (default), `same-site`, `same-origin`, or `disabled`. |
| `<PREFIX>_CROSS_ORIGIN_OPENER_POLICY` | `same-origin` (default), `same-origin-allow-popups`, `unsafe-none`, or `disabled`. |
| `<PREFIX>_FRAME_OPTIONS` | `DENY` (default), `SAMEORIGIN`, or `disabled`. |
| `<PREFIX>_PERMISSIONS_POLICY` | A single-line Permissions Policy, or `disabled`. |
| `<PREFIX>_STRICT_TRANSPORT_SECURITY` | `true` (default) or `false`; applies only to a trusted secure request. |

HTML surfaces use an explicit CSP:

- OverlayExpress exposes CSP and related header overrides through
  `configureEdgePolicy({ securityHeaders })`.
- Wallet `StorageServer` exposes `securityHeaders`; `AdminServer` exposes
  `adminSecurityHeaders`.
- API-only services retain the strict `default-src 'none'` baseline unless an
  operator deliberately overrides it.

Operators should add only the script, style, image, font, and connection
origins actually required by their deployed UI. Wallet/pop-up integrations
that need to retain an opener can select `same-origin-allow-popups`; embeddable
operator UIs can coordinate CSP `frame-ancestors` with `FRAME_OPTIONS`.

### Resource and error behavior

- Body and timeout environment values are positive, bounded integers; invalid
  values fail startup.
- Oversized bodies return `413 ERR_BODY_TOO_LARGE`.
- Malformed JSON returns `400 ERR_INVALID_BODY`.
- Local concurrency exhaustion returns `503 ERR_SERVER_BUSY` and
  `Retry-After: 1`.
- Rate exhaustion returns `429 ERR_RATE_LIMITED` and standard draft-8 rate
  headers.
- Internal exceptions are logged server-side and use stable external errors.
- Request logs contain route and size metadata, not auth/payment headers,
  presentation keys, OTP stores, Shamir shares, private keys, or message
  bodies.

Per-process counters are not a global distributed quota. Replicated
deployments must use a shared rate-limit/session store or enforce the aggregate
limit at a trusted ingress. Proxy hop counts must match the actual deployment;
permissive proxy trust is not supported.

## Endpoint inventory

“Public” below means no application identity is required. All routes still
receive the shared CORS, concurrency, timeout, and parser protections.

### WAB

Prefix: `WAB`. JSON limit: 256 KiB. Concurrency: 200.

| Endpoints | Access and controls |
|---|---|
| `GET /info` | Public capability metadata. DevConsole is advertised only when explicitly enabled in a `development` or `test` runtime. |
| `POST /auth/start`, `/auth/complete` | Public OTP exchange; 10 attempts/15 minutes per IP. Twilio provider failures and internal exceptions are not exposed. |
| `POST /account/delete/start`, `/account/delete/complete` | OTP-confirmed deletion; 5 attempts/15 minutes. |
| `POST /user/linkedMethods`, `/user/unlinkMethod`, `/user/delete` | Presentation-key operations; 120 operations/15 minutes. |
| `POST /faucet/request` | Presentation-key faucet workflow; 5 attempts/hour. |
| `POST /share/store`, `/share/retrieve`, `/share/update`, `/share/delete` | OTP-confirmed Shamir-share operations; 10 attempts/15 minutes plus persistent user/IP operation limits. |

The DevConsole method requires both
`DEV_CONSOLE_AUTH_METHOD_ENABLED=true` and `NODE_ENV=development|test`.
Its singleton OTP store is shared across the auth and share controllers. It
logs the development OTP by design, but never logs presentation keys, request
payloads, or the OTP store. Production and staging cannot enable it.

### UHRP basic server

Prefix: `UHRP`. JSON limit: 256 KiB. Upload limit: 64 MiB.
Concurrency: 100. Pre-auth: 300/minute per IP. Authenticated: 1,000/minute per
identity.

| Endpoints | Access and controls |
|---|---|
| Static `GET`/`HEAD` under the public object directory | Public immutable object retrieval with CDN MIME handling. |
| `PUT /put` | HMAC-authorized streaming upload. Authorization and declared size are checked before body consumption; bytes stream to a private temporary file, hash incrementally, and atomically commit without overwriting an existing path. |
| `POST /quote` | Public, bounded pricing calculation. |
| `POST /upload` | BRC-103 identity required; payment price is based on declared size/retention. Returns an upload authorization rather than accepting object bytes. |
| `GET /list`, `GET /find` | BRC-103 identity required; queries are scoped to the authenticated uploader. |
| `POST /renew` | BRC-103 identity and payment policy; metadata ownership is checked. |

The default 64 MiB ceiling remains configurable and bounded, but upload memory
use is independent of object size. Truncated, oversized, unauthorized,
expired, path-invalid, and concurrent-overwrite attempts fail without
publishing a partial object.

### UHRP cloud-bucket server

Prefix: `UHRP`. JSON limit: 256 KiB. Concurrency: 200. Pre-auth:
300/minute per IP. Authenticated: 1,000/minute per identity.

| Endpoints | Access and controls |
|---|---|
| Static `GET`/`HEAD` content | Public object retrieval; cloud storage remains the object source of truth. |
| `POST /advertise` | Administrative operation using an `Authorization: Bearer` token of at least 32 characters, compared in constant time. |
| `POST /quote` | Public, bounded pricing calculation. |
| `POST /upload` | BRC-103 identity required; creates the cloud upload workflow and applies payment policy. |
| `GET /list`, `GET /find` | BRC-103 identity required and uploader-scoped. |
| `POST /renew` | BRC-103 identity required; ownership and payment policy apply. |

Production HTTPS enforcement relies only on Express `req.secure` after an
explicit proxy trust configuration. Nginx and the service configuration cap
JSON bodies at 256 KiB and use 60-second request/upstream timeouts.

### Message Box

Prefixes: `MESSAGE_BOX`, `MESSAGE_BOX_WEBSOCKET`. JSON limit: 4 MiB.
WebSocket message limit: 1 MiB. Concurrency: 200. Pre-auth: 300/minute per IP.
Authenticated HTTP: 1,000/minute per identity.

| Endpoints | Access and controls |
|---|---|
| `GET /docs`, `GET /openapi.json` | Public API documentation. |
| `POST /sendMessage` | BRC-103 identity plus recipient permission/fee policy. At most 100 recipients, 128-byte box names, 256-byte message IDs, and 1 MiB message bodies. |
| `POST /listMessages`, `/acknowledgeMessage` | BRC-103 identity; database queries/deletes are recipient-scoped. |
| `POST /registerDevice`, `GET /devices` | BRC-103 identity; device records are identity-scoped and returned push tokens are truncated. |
| `GET /permissions/get`, `/permissions/list`, `/permissions/quote`; `POST /permissions/set` | BRC-103 identity; permission ownership and 100-recipient quote cap apply. |
| WebSocket `authenticated` | The claimed key must match the identity discovered by the signed BRC-103 event. Payload claims are never trusted as identity. |
| WebSocket `joinRoom`, `leaveRoom` | Only `{authenticatedIdentityKey}-{messageBox}` names are accepted. |
| WebSocket `sendMessage` | Reuses the HTTP handler’s validation, permission, fee, duplicate, and persistence policy. Paid sends fall back to authenticated HTTP. Notifications are delivered only to sockets mapped to the recipient’s BRC-103 identity, never broadcast globally. |

The nginx body limit is 4 MiB, with bounded header, body, send, and upstream
timeouts. WebSocket origins use the same public/allowlist/disabled CORS mode as
HTTP.

### Chaintracks server and reusable ChaintracksService

Prefixes: `CHAINTRACKS`, `CHAINTRACKS_CDN`. JSON limit: 256 KiB.
Concurrency: 200 API / 100 CDN.

All Chaintracks data is public. Mutation is limited to the compatibility
`POST /addHeaderHex` path, which validates the submitted block header in the
Chaintracks implementation.

| Surface | Endpoints |
|---|---|
| Service metadata | `GET /`, `GET /robots.txt` |
| v1 JSON | `GET /getChain`, `/getInfo`, `/getPresentHeight`, `/findChainTipHashHex`, `/findChainTipHeaderHex`, `/findHeaderHexForHeight`, `/findHeaderHexForBlockHash`, `/getHeaders`, `/getFiatExchangeRates`; `POST /addHeaderHex` |
| v2 JSON/binary | `GET /v2/network`, `/v2/tip`, `/v2/header/height/:height`, `/v2/header/hash/:hash`, `/v2/headers`, `/v2/tip.bin`, `/v2/header/height/:height.bin`, `/v2/header/hash/:hash.bin`, `/v2/headers.bin` |
| Optional bulk CDN | Static `GET`/`HEAD` under the configured bulk-header root |

Responses use stable internal-error envelopes. Query/body limits and the
connection policy bound malformed or slow clients.

### OverlayExpress

Prefix: `OVERLAY`. JSON limit: 8 MiB. Binary limit: 64 MiB. Concurrency: 200.

| Surface | Endpoints and access |
|---|---|
| UI and health | Public `GET /`, `/health/live`, `/health/ready`, `/health`. |
| Discovery/docs | Public `GET /listTopicManagers`, `/listLookupServiceProviders`, `/getDocumentationForTopicManager`, `/getDocumentationForLookupServiceProvider`. |
| Overlay protocol | Public `POST /submit`, `/lookup`; conditional `/arc-ingest`; GASP `/requestSyncResponse`, `/requestForeignGASPNode`; BASM `/requestTopicAnchorTip`, `/requestTopicAnchorRange`, `/requestAdmittedList`, `/requestCompoundMerklePath`, `/requestRawTransactions`. |
| Public admin metadata | `GET /admin/config` returns only node name and the configured public admin identity key. |
| Protected admin reads | `GET /admin/stats`, `/admin/ship-records`, `/admin/slap-records`, `/admin/bans`. |
| Protected admin writes | `POST /admin/health-check`, `/admin/ban`, `/admin/unban`, `/admin/remove-token`, `/admin/syncAdvertisements`, `/admin/startGASPSync`, `/admin/startBASMSync`, `/admin/evictUnproven`, `/admin/refreshUnprovenProofs`, `/admin/maintainUnproven`, `/admin/evictOutpoint`, `/admin/janitor`. |

Admin operations require either the configured Bearer token or BRC-103
authentication matching the configured admin identity key. The maintained
deployment rejects configured admin tokens shorter than 32 characters, and
Bearer-token comparison is constant-time. Janitor outbound
health checks reject credentials, queries/fragments, HTTP, nonstandard ports,
localhost/private/special IP literals, and redirects by default.
`allowPrivateHosts` is an explicit isolated-development override.

Verbose request logging redacts auth, cookie, token, payment, signature, and
nonce headers and records body type/size only. Overlay UI CSP and edge limits
are configurable through `configureEdgePolicy`.

### Wallet StorageServer and AdminServer

Prefixes: `WALLET_STORAGE`, `WALLET_ADMIN`. Storage JSON limit: 30 MiB.
Storage binary limit: 8 MiB. Storage concurrency: 200. Admin JSON limit:
1 MiB. Admin concurrency: 50.

| Surface | Endpoints and access |
|---|---|
| Storage metadata | Public `GET /`, `GET /robots.txt`. |
| Blob upload | BRC-103-authenticated `PUT /action-batch/:batchId/blob/:digest`; action-batch ownership and digest validation are enforced by storage. |
| Storage RPC | BRC-103-authenticated `POST /`; optional payment middleware, method allowlist, authenticated `AuthId` checks, and JSON-RPC validation apply. |
| Admin liveness/UI assets | `GET /healthz`, `/admin`, `/admin/assets/bsv-sdk.js`. If admin identity configuration is absent, the server fails closed with 503 for later routes. |
| Admin API | Authenticated and allowlisted identity required for stats, events, tasks, users, call history, UTXO review, transaction review/decode/rebroadcast, and manual task execution. |

Storage pre-auth limits default to 300/minute per IP and authenticated limits
to 1,000/minute per identity; callers can provide shared stores. Short-request
and RPC logging records metadata only. Nginx caps requests at 30 MiB and does
not replay state-changing RPC requests to another upstream.

## Threat model and retest checklist

The boundary assumes TLS is terminated either in-process or at the explicitly
trusted ingress. Databases, bucket credentials, server private keys, admin
tokens, and shared rate-limit/session stores are operator-managed secrets.

Review each release against these abuse cases:

- anonymous body/connection exhaustion before authentication;
- authenticated high-cardinality or expensive requests;
- spoofed forwarding headers and identity claims;
- cross-origin browser compatibility and allowlist enforcement;
- parser/streaming size differentials between proxy and application;
- path traversal, overwrite races, and object ownership;
- message recipient/room confusion and global broadcast leakage;
- SSRF through overlay health checks and redirects;
- replay of state-changing requests by proxies;
- sensitive headers, bodies, OTPs, shares, keys, or provider errors in logs;
- verbose internal errors returned to public clients; and
- horizontal replicas bypassing per-process limits.

Required local evidence for edge-policy changes:

```sh
pnpm health:check
pnpm build
pnpm --filter @bsv/overlay-express test
pnpm --filter @bsv/authsocket test
pnpm --filter @bsv/wallet-toolbox test
```

Each affected standalone infra directory must also pass its own build, lint,
tests, and `npm audit`. The pull request must then pass repository CI,
conformance, CodeQL, SonarCloud analysis, and patch coverage before merge.
