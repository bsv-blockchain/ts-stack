---
id: infra-uhrp-basic
title: "UHRP Server (Basic)"
kind: infra
version: "0.1.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: beta
tags: [uhrp, storage, file-server, development, lightweight]
---

# UHRP Server (Basic)

> A simple, file-system based UHRP (Universal Host Reference Protocol) host server. Stores files locally on disk and provides HTTP endpoints for UHRP data retrieval and storage.

## What it does

A lightweight Node.js server with Express that implements UHRP endpoints for file storage and retrieval. Files are stored on local filesystem (configurable via `./public` or `./data` directory), served by HTTP with public GET access, and uploads via PUT are authenticated with BRC-103 signatures. The server calculates pricing per GB/month (advisory pricing, not enforced by default) and provides a simple POST /lookup endpoint for UHRP metadata queries. No database dependencies — all file metadata stored as JSON alongside files.

Clients PUT files with authentication, retrieve files via public GET, and query metadata via POST /lookup.

## When to deploy this

- Local development and testing of UHRP clients
- Proof-of-concept deployments with small file volumes
- Single-server setups without cloud infrastructure
- Educational or internal network use

## Dependencies

| Type | Requirement |
|------|-------------|
| Database | None; filesystem-based storage |
| External services | Wallet Storage (WALLET_STORAGE_URL), ARC (optional for payment transactions) |
| ts-stack packages | @bsv/sdk, @bsv/auth-express-middleware, @bsv/payment-express-middleware, @bsv/wallet-toolbox-client |

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| PUT | /put/{hash} | Upload file to local storage (authenticated, priced) |
| GET | /{hash} | Retrieve file from local storage (public) |
| POST | /lookup | UHRP lookup queries to find files and metadata (public) |
| GET | /info | Server info and pricing details (public) |
| GET | / | Health/readiness check (HTTP 200) |

## WebSocket endpoints

None.

## Configuration (env vars)

| Variable | Required | Description |
|----------|----------|-------------|
| PRICE_PER_GB_MO | No | Monthly storage price per GB (e.g., `0.03`) |
| HOSTING_DOMAIN | No | Public domain for server advertisement (e.g., `localhost:8080` or `https://uhrp.example.com`) |
| BSV_NETWORK | No | Target blockchain network (e.g., `mainnet` or `testnet`) |
| WALLET_STORAGE_URL | No | Wallet storage endpoint for key derivation (e.g., `https://storage.babbage.systems`) |
| SERVER_PRIVATE_KEY | Yes | 256-bit hex private key for server identity |
| HTTP_PORT | No | Express server port (default: 8080) |
| NODE_ENV | No | `development` or `production` |

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

# Or as Docker container (lightweight ts-node, no Dockerfile provided)
docker run -d \
  -e SERVER_PRIVATE_KEY=<256-bit-hex> \
  -e HOSTING_DOMAIN=https://uhrp.example.com \
  -e HTTP_PORT=8080 \
  -v uhrp_data:/app/public \
  -p 8080:8080 \
  node-uhrp-server:latest
```

No docker-compose.yml or nginx.conf provided; filesystem-based, no external database. Direct Express server on configured port.

## Migrations

None; stateless server with files stored directly on disk with JSON metadata.

## Health checks

Implicit health via GET / returning HTTP 200. No explicit health endpoint. Monitor disk space and file directory accessibility.

## Spec conformance

- **UHRP** – Implements basic UHRP host protocol for file storage and retrieval
- **BRC-103** – Mutual authentication on PUT (authenticated endpoint)
- **BRC-100** – Optional payment verification (via payment middleware if enabled)

## Integration with ts-stack

- UHRP clients upload/retrieve files using SERVER_PRIVATE_KEY and HOSTING_DOMAIN
- Wallet Storage derives keys from SERVER_PRIVATE_KEY, validates optional payments
- Overlay nodes can advertise UHRP hosting capability via overlay
- No npm package published; standalone reference implementation

## Common pitfalls

- No cleanup mechanism: files persist until manually deleted; monitor disk usage in production
- Pricing is advisory: PRICE_PER_GB_MO displayed but not enforced unless payment middleware configured
- Single instance only: no built-in replication or load balancing
- MIME types auto-detected from file extension; unusual extensions may lack proper type
- Direct disk access: ensure filesystem permissions allow Node.js process read/write access
- No backup strategy: files lost if filesystem corrupted; implement external backup policy

## Source

- [GitHub](https://github.com/bsv-stack/uhrp-server-basic)
- [npm package](https://npmjs.com/package/@bsv/uhrp-lite)
