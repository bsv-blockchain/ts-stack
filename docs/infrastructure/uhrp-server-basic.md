---
id: infra-uhrp-basic
title: 'UHRP Server (Basic)'
kind: infra
version: '0.1.32'
last_updated: '2026-08-24'
last_verified: '2026-08-24'
review_cadence_days: 30
status: beta
tags: [uhrp, storage, file-server, development, lightweight]
---

# UHRP Server (Basic)

> A simple, file-system based UHRP (Universal Host Reference Protocol) host server. Stores files locally on disk and provides HTTP endpoints for UHRP data retrieval and storage.

## What it does

A lightweight Node.js server with Express that implements UHRP storage and
metadata endpoints. Files are served publicly from the local object directory.
The raw `PUT /put` commit is HMAC-authorized; the upload, list, find, and renew
workflows require BRC-103 identity, and payment policy runs after
authentication.

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
| External services | Wallet Storage (WALLET_STORAGE_URL)                                                                |
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

| Variable                   | Required | Description                                                                                   |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| PRICE_PER_GB_MO            | No       | Monthly storage price per GB (e.g., `0.03`)                                                   |
| HOSTING_DOMAIN             | No       | Public domain for server advertisement (e.g., `localhost:8080` or `https://uhrp.example.com`) |
| BSV_NETWORK                | No       | `mainnet`, `testnet`, `ttn`, or `teratestnet` (default `mainnet`)                         |
| WALLET_STORAGE_URL         | No       | Wallet storage endpoint for key derivation (e.g., `https://store-us-1.bsvb.tech`)             |
| SERVER_PRIVATE_KEY         | Yes      | 256-bit hex private key for server identity                                                   |
| HTTP_PORT                  | No       | Express server port (default: 8080)                                                           |
| NODE_ENV                   | No       | `development` or `production`                                                                 |
| UHRP_CORS_MODE             | No       | `public` (default), `allowlist`, or `disabled`                                                |
| UHRP_CORS_ALLOWED_ORIGINS  | No       | Exact comma-separated origins in allowlist mode                                               |
| UHRP_CORS_ALLOWED_HEADERS  | No       | Strict comma-separated browser request-header allowlist; omit for additive compatibility      |
| UHRP_UPLOAD_MAX_BODY_BYTES | No       | Raw `/put` ceiling (default 67108864)                                                         |
| UHRP_JSON_MAX_BODY_BYTES   | No       | JSON ceiling (default 262144)                                                                 |
| TRUST_PROXY_HOPS           | No       | Exact trusted proxy hop count, 0 through 10                                                   |

`PUT /put` validates authorization, expiry, declared size, and any
`Content-Length` before consuming the body. It streams into a private
same-filesystem temporary file, hashes incrementally, and uses exclusive
atomic linking so partial data and overwrites are never published.

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

# Or build the checked-in multi-stage production image
docker build -t uhrp-lite:local .
docker run -d \
  -e SERVER_PRIVATE_KEY=<256-bit-hex> \
  -e HOSTING_DOMAIN=https://uhrp.example.com \
  -e HTTP_PORT=8080 \
  -v uhrp_data:/app/public \
  -p 8080:8080 \
  uhrp-lite:local
```

The Dockerfile compiles TypeScript in a disposable Node 24 build stage, runs
the built server as the unprivileged `node` user, and probes `/ready`.
No compose file or external database is required.

## Migrations

None; stateless server with files stored directly on disk with JSON metadata.

## Health checks

- `GET /health` and `GET /healthz` report process liveness.
- `GET /ready` returns 200 only after startup completes and 503 while the
  process is starting or shutting down.
- The container health check probes `/ready`. Operators must additionally
  monitor disk space and object-directory accessibility.

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

- No cleanup mechanism: files persist until manually deleted; monitor disk usage in production
- Raw object commit is HMAC-authorized; authenticated upload/renew workflows apply payment middleware
- Single instance only: no built-in replication or load balancing
- MIME types auto-detected from file extension; unusual extensions may lack proper type
- Direct disk access: ensure filesystem permissions allow Node.js process read/write access
- No backup strategy: files lost if filesystem corrupted; implement external backup policy

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/uhrp-server-basic)
- [npm package](https://npmjs.com/package/@bsv/uhrp-lite)
