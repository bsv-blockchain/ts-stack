---
id: infra-uhrp-basic
title: 'UHRP Server (Basic)'
kind: infra
version: '0.1.38'
last_updated: '2026-09-16'
last_verified: '2026-09-16'
review_cadence_days: 30
status: beta
tags: [uhrp, storage, file-server, development, lightweight]
---

# UHRP Server (Basic)

> A simple, file-system based UHRP (Universal Host Reference Protocol) host server. Stores files locally on disk and provides HTTP endpoints for UHRP data retrieval and storage.

The 0.1.38 source candidate completes the GHSA-v356-28v3-rj46 remediation
record with exploit-shaped path and HMAC regression coverage, aligns public
reads with the same canonical CDN root used by uploads, and denies dot-file and
directory-index static behavior. Valid Base58 object identifiers, upload HMAC
inputs, and response envelopes are unchanged.

The 0.1.34 image refreshes its Alpine OpenSSL runtime libraries to 3.5.8-r0
to remediate CVE-2026-14456. Service APIs, storage formats, CHIRP behavior, and
deployment configuration are unchanged from 0.1.33.

## What it does

A lightweight Node.js server with Express that implements UHRP storage and
metadata endpoints. Files are served publicly from the local object directory.
The raw `PUT /put` commit is HMAC-authorized; the upload, list, find, and renew
workflows require BRC-103 identity, and payment policy runs after
authentication.

The on-chain advertisement authenticates host, hash, location, expiry, and
size, but not uploader ownership or the service's local object identifier.
Owner-only management therefore requires a server-signed local metadata
envelope bound to the exact wallet/BEEF output. Unsigned legacy metadata must
be re-advertised before it can be listed or renewed as owned; public UHRP reads
remain available. Arbitrary public objects are served as sandboxed attachments
with MIME sniffing disabled.

Clients PUT files with authentication, retrieve files via public GET, and query metadata via POST /lookup.

## When to deploy this

- Local development and testing of UHRP clients
- Proof-of-concept deployments with small file volumes
- Single-server setups without cloud infrastructure
- Educational or internal network use

## Dependencies

| Type              | Requirement                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Database          | None; filesystem-based storage                                                                      |
| External services | Wallet Storage (WALLET_STORAGE_URL)                                                                 |
| ts-stack packages | @bsv/sdk, @bsv/auth-express-middleware, @bsv/payment-express-middleware, @bsv/wallet-toolbox-client |

## HTTP endpoints

| Method   | Path                | Purpose                                                          |
| -------- | ------------------- | ---------------------------------------------------------------- |
| GET/HEAD | Static object paths | Retrieve stored files (public)                                   |
| PUT      | /put                | HMAC-authorized streaming object commit (64 MiB default ceiling) |
| POST     | /quote              | Public storage-price quote                                       |
| POST     | /upload             | Authenticated upload authorization and payment workflow          |
| GET      | /list               | List the authenticated uploader's objects                        |
| GET      | /find               | Find authenticated uploader metadata                             |
| POST     | /renew              | Authenticated ownership/payment renewal                          |

## WebSocket endpoints

None.

## Configuration (env vars)

| Variable                               | Required | Description                                                                                       |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| PRICE_PER_GB_MO                        | No       | Canonical positive-decimal monthly USD price per GB (e.g., `0.03`, maximum `1000000`)             |
| HOSTING_DOMAIN                         | No       | Public domain for server advertisement (e.g., `localhost:8080` or `https://uhrp.example.com`)     |
| BSV_NETWORK                            | No       | `mainnet`, `testnet`, `ttn`, or `teratestnet` (default `mainnet`)                                 |
| WALLET_STORAGE_URL                     | No       | Wallet storage endpoint for key derivation (e.g., `https://store-us-1.bsvb.tech`)                 |
| SERVER_PRIVATE_KEY                     | Yes      | 256-bit hex private key for server identity and upload HMAC signing; treat as a high-value secret |
| HTTP_PORT                              | No       | Express server port (default: 8080)                                                               |
| NODE_ENV                               | No       | `development` or `production`                                                                     |
| UHRP_CORS_MODE                         | No       | `public` (default), `allowlist`, or `disabled`                                                    |
| UHRP_CORS_ALLOWED_ORIGINS              | No       | Exact comma-separated origins in allowlist mode                                                   |
| UHRP_CORS_ALLOWED_HEADERS              | No       | Strict comma-separated browser request-header allowlist; omit for additive compatibility          |
| UHRP_UPLOAD_MAX_BODY_BYTES             | No       | Raw `/put` ceiling (default 67108864)                                                             |
| UHRP_JSON_MAX_BODY_BYTES               | No       | JSON ceiling (default 262144)                                                                     |
| TRUST_PROXY_HOPS                       | No       | Exact trusted proxy hop count, 0 through 10                                                       |
| CHIRP_MAX_ACTIVE_SESSIONS              | No       | Host-wide active staging-session ceiling (default 1024)                                           |
| CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY | No       | Active staging-session ceiling per authenticated identity (default 8)                             |
| CHIRP_MAX_STAGED_OBJECTS_PER_SESSION   | No       | Per-session staged-object ceiling (default 4096)                                                  |
| CHIRP_MIN_FREE_BYTES                   | No       | Filesystem headroom reserved before accepting an object (default 1 GiB)                           |
| CHIRP_GC_MAX_ENTRIES                   | No       | Maximum unreferenced object deletions per GC cycle (default 100000)                               |

The external exchange-rate lookup rejects redirects, has a ten-second absolute
deadline and a 64 KiB response ceiling, and accepts only a bounded positive
rate. Transport, payload, or plausibility failure uses the local fallback rate,
so the rate provider cannot indefinitely stall pricing or force an unboundedly
low quote.

`PUT /put` validates authorization, expiry, declared size, and any
`Content-Length` before consuming the body. Object identifiers are confined to
flat Base58 names directly beneath the public CDN root, so traversal forms
cannot escape the object store. It streams into a private same-filesystem
temporary file, hashes incrementally, and uses exclusive atomic linking so
partial data and overwrites are never published. CHIRP session allocation and
object staging are quota-bound before paid commit, same-root commits are
serialized across sessions, and garbage collection continues in bounded
batches even above its per-cycle deletion threshold.

See [Public Service Edge Security](service-edge-security.md#uhrp-basic-server)
for the complete endpoint threat model.

## Run locally

```bash
# Install dependencies
npm install

# Development with nodemon hot-reload
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

Files stored in `./public` or configured data directory.

## Deploy to production

```bash
# Build and start
npm run build && npm start

# Or build the repository's digest-pinned, multi-stage Node 24 image
docker build -t uhrp-lite:local .
docker run -d \
  -e SERVER_PRIVATE_KEY=<256-bit-hex> \
  -e HOSTING_DOMAIN=https://uhrp.example.com \
  -e HTTP_PORT=8080 \
  -v uhrp_data:/app/public \
  -p 8080:8080 \
  uhrp-lite:local
```

The container runs as the unprivileged `node` user and probes `/ready` before
it is considered healthy. The service remains filesystem-based with no
external database; mount durable storage at `/app/public`.

## Migrations

CHIRP session and lease metadata is stored as atomic JSON beside the
content-addressed filesystem objects. Legacy UHRP wallet outputs with unsigned
`customInstructions` remain publicly retrievable when advertised on-chain but
must be re-advertised to acquire authenticated owner metadata before private
list, find, or renew operations.

## Health checks

- `GET /health` and `GET /healthz` report process liveness.
- `GET /ready` returns 200 only after wallet-backed authentication and payment
  middleware initialization completes.
- Monitor disk space and the mounted object directory separately.

## Spec conformance

- **UHRP** – Implements basic UHRP host protocol for file storage and retrieval
- **BRC-103** – Mutual authentication on uploader metadata and renewal endpoints
- **BRC-100** – Optional payment verification (via payment middleware if enabled)

## Integration with ts-stack

- UHRP clients upload/retrieve files using SERVER_PRIVATE_KEY and HOSTING_DOMAIN
- Wallet Storage derives keys from SERVER_PRIVATE_KEY, validates optional payments
- Overlay nodes can advertise UHRP hosting capability via overlay
- No npm package published; standalone reference implementation

## Common pitfalls

- CHIRP garbage collection expires staging sessions and leases and deletes
  unreferenced objects in bounded batches; legacy UHRP objects remain operator-managed
- Raw object commit is HMAC-authorized; authenticated upload/renew workflows apply payment middleware
- Single instance only: no built-in replication or load balancing
- MIME types auto-detected from file extension; unusual extensions may lack proper type
- Direct disk access: ensure filesystem permissions allow Node.js process read/write access
- No backup strategy: files lost if filesystem corrupted; implement external backup policy

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/uhrp-server-basic)
- [npm package](https://npmjs.com/package/@bsv/uhrp-lite)
