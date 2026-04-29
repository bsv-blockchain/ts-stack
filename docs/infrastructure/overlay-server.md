---
id: infra-overlay-server
title: "Overlay Server"
kind: infra
version: "2.1.6"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [overlay, topic-manager, lookup-service, transaction-routing]
---

# Overlay Server

> A reference implementation of an overlay node built on @bsv/overlay-express. Implements topic managers and lookup services to enable distributed applications to organize and query blockchain data efficiently.

## What it does

The Overlay Server bootstraps topic managers and lookup services from @bsv/overlay-express. Topic managers validate which transaction outputs are admissible to the overlay by decoding PushDrop-encoded outputs, verifying signatures and cryptographic proofs, and returning AdmittanceInstructions. Lookup services store admitted outputs in MongoDB and respond to queries via the SLAP protocol. The server coordinates with a WalletAdvertiser for overlay advertising and connects to both MongoDB (lookup storage) and MySQL/Knex (overlay transaction tracking).

Clients submit transaction outputs via HTTP, the server routes valid outputs through registered topic managers, stores admitted outputs, and serves queries from any peer.

## When to deploy this

- Running an overlay node with topic managers and lookup services
- You need to organize and index blockchain outputs by topic
- Require distributed query capability across peers
- Building services on top of overlay (ProtoMap, CertMap, UHRP, etc.)

## Dependencies

| Type | Requirement |
|------|-------------|
| Database | MongoDB (lookup data), MySQL/Knex (overlay tracking) |
| External services | ARC API key (transaction broadcasting), Wallet Storage (key derivation) |
| ts-stack packages | @bsv/sdk, @bsv/overlay-express, @bsv/auth-express-middleware |

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | / | Submit transaction (default OverlayExpress endpoint) |

Additional endpoints exposed by configured topic managers and lookup services (see src/services/ for ProtoMap, CertMap, BasketMap, UHRP, Identity, MessageBox, UMP, etc.).

## WebSocket endpoints

None (HTTP-only OverlayExpress endpoints).

## Configuration (env vars)

| Variable | Required | Description |
|----------|----------|-------------|
| NODE_NAME | Yes | One-word, lowercase overlay service node identifier |
| SERVER_PRIVATE_KEY | Yes | 32-byte hex root private key for server wallet |
| HOSTING_URL | Yes | Public URL where the node is reachable |
| ADMIN_TOKEN | Yes | Token for admin API access |
| WALLET_STORAGE_URL | Yes | BSV wallet storage endpoint (e.g., `https://store-us-1.bsvb.tech`) |
| NETWORK | Yes | `main` or `test` (BSV blockchain network) |
| ARC_API_KEY | Yes | ARC key for transaction broadcasting |
| MONGO_URL | Yes | MongoDB connection string |
| KNEX_URL | Yes | MySQL connection string for Knex |
| GASP_ENABLED | No | `true` or `false` (Graph Aware Sync Protocol for overlay sync) |

## Run locally

```bash
# Install dependencies
npm install

# Development with hot-reload (uses tsx)
npm run dev

# Build TypeScript to dist/
npm run build

# Run production build
npm start

# Full stack with Docker Compose (app + MongoDB + MySQL)
docker compose up --build
```

## Deploy to production

```bash
# Multi-stage build: Node builder → production runtime
docker build -t overlay-server:latest .

# Run with environment variables
docker run -d \
  -e NODE_NAME=overlay-node-1 \
  -e SERVER_PRIVATE_KEY=<32-byte-hex> \
  -e HOSTING_URL=https://overlay.example.com \
  -e ADMIN_TOKEN=<secure-token> \
  -e WALLET_STORAGE_URL=https://store-us-1.bsvb.tech \
  -e NETWORK=main \
  -e ARC_API_KEY=<arc-key> \
  -e MONGO_URL=mongodb://mongo:27017/overlay \
  -e KNEX_URL=mysql://user:pass@mysql:3306/overlay \
  -p 8080:8080 \
  overlay-server:latest

# Or with Docker Compose (includes MongoDB, MySQL, janitor service)
docker compose up -d
```

Service listens on port 8080 by default. Kubernetes deployment files available in deploy/ (app-deployment.yaml, mongodb, mysql with persistent volumes).

## Migrations

Managed by @bsv/overlay-express and Knex. Auto-run on startup. Tables: outputs, topic_managers, lookup_services, with indexes on identity_key, output_hash, blockchain_height.

## Health checks

No explicit health endpoint. Monitor:
- MongoDB and MySQL connectivity
- OverlayExpress admin endpoints (require ADMIN_TOKEN)
- Topic manager and lookup service status via admin API

## Spec conformance

- **Topic Manager Pattern** – Validates outputs via identifyAdmissibleOutputs() method
- **Lookup Service Pattern** – Stores/queries via outputAdmittedByTopic(), outputSpent(), lookup() methods
- **PushDrop (BRC-48)** – Standard output decoding format
- **GASP** – Graph Aware Sync Protocol for multi-node overlay synchronization (disable for simple local deployments)

## Integration with ts-stack

- Implements topic managers and lookup services from @bsv/sdk Transaction and PushDrop utilities
- Coordinates with WalletAdvertiser for overlay service advertisement
- Uses @bsv/overlay-express server configuration and routing
- Connects wallet operations to blockchain via ARC and Wallet Storage
- Services registered in src/index.ts: tm_protomap, ls_protomap, tm_certmap, ls_certmap, tm_uhrp, ls_uhrp, etc.

## Common pitfalls

- Topic manager IDs must start with `tm_`, lookup service IDs with `ls_`
- Invalid outputs must be silently skipped in topic managers (don't throw errors)
- Lookup services use factory pattern returning instances from MongoDB connection
- GASP sync may cause conflicts if disabled on some nodes; keep consistent across deployment
- Admin API requires ADMIN_TOKEN in Authorization header; unauthenticated calls rejected
- Database indexes critical for performance with large transaction volumes

## Source

- [GitHub](https://github.com/bsv-blockchain/overlay-express-examples)
- [npm package](https://npmjs.com/package/@bsv/overlay-express)
