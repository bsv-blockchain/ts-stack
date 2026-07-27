---
id: infra-overlay-server
title: 'Overlay Server'
kind: infra
version: '2.1.6'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
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

| Type              | Requirement                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database          | MongoDB (lookup data), MySQL/Knex (overlay tracking)                                                                                                |
| External services | Wallet Storage (service advertisement), Arcade and/or Arc (transaction propagation), Chaintracks/go-chaintracks-compatible headers and reorg stream |
| ts-stack packages | @bsv/sdk, @bsv/overlay-express, @bsv/auth-express-middleware                                                                                        |

## HTTP endpoints

| Method | Path                         | Purpose                                                                      |
| ------ | ---------------------------- | ---------------------------------------------------------------------------- |
| POST   | /submit                      | Submit a tagged BEEF transaction for topic admission and network propagation |
| POST   | /lookup                      | Query a lookup service                                                       |
| POST   | /arc-ingest                  | Receive Arc/Arcade provider callbacks and Merkle proofs                      |
| GET    | /health/live                 | Process liveness                                                             |
| GET    | /health/ready                | Readiness for critical dependencies                                          |
| GET    | /health                      | Full health report with provider/BASM context                                |
| POST   | /admin/syncAdvertisements    | Refresh SHIP/SLAP advertisements                                             |
| POST   | /admin/startGASPSync         | Run GASP sync                                                                |
| POST   | /admin/startBASMSync         | Run BASM sync                                                                |
| POST   | /admin/refreshUnprovenProofs | Try proof providers for old unproven transactions                            |
| POST   | /admin/evictUnproven         | Evict old unproven transactions without proof refresh                        |
| POST   | /admin/maintainUnproven      | Refresh proofs, then evict remaining old unproven transactions               |
| POST   | /admin/evictOutpoint         | Remove an outpoint from lookup service indexes                               |
| POST   | /admin/janitor               | Run SHIP/SLAP host health checks and cleanup                                 |

Additional endpoints exposed by configured topic managers and lookup services (see src/services/ for ProtoMap, CertMap, BasketMap, UHRP, Identity, MessageBox, UMP, etc.).

## WebSocket endpoints

None (HTTP-only OverlayExpress endpoints).

## Configuration (env vars)

| Variable                         | Required      | Description                                                                                                                               |
| -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| NODE_NAME                        | Yes           | One-word, lowercase overlay service node identifier                                                                                       |
| SERVER_PRIVATE_KEY               | Yes           | 32-byte hex root private key for server wallet                                                                                            |
| HOSTING_URL                      | Yes           | Public URL where the node is reachable                                                                                                    |
| ADMIN_TOKEN                      | Yes           | Token for admin API access                                                                                                                |
| WALLET_STORAGE_URL               | Yes           | BSV wallet storage endpoint (e.g., `https://store-us-1.bsvb.tech`)                                                                        |
| NETWORK                          | Yes           | `main` or `test` (BSV blockchain network)                                                                                                 |
| ARC_API_KEY                      | Conditionally | Arc key for fallback transaction broadcasting. Required only when `ARCADE_URL` is unset.                                                  |
| ARC_CALLBACK_TOKEN               | No            | Shared secret expected on `/arc-ingest` callbacks. Recommended for public deployments.                                                    |
| ARCADE_URL                       | Conditionally | Arcade endpoint used as the first-choice broadcaster and proof lookup provider. Required only when `ARC_API_KEY` is unset.                |
| ARCADE_API_KEY                   | No            | Arcade API key, when the deployment requires one.                                                                                         |
| ARCADE_DEPLOYMENT_ID             | No            | Stable Arcade deployment identifier used for callback/proof routing.                                                                      |
| CHAINTRACKS_URL                  | No            | Explicit go-chaintracks compatible endpoint for headers and reorg SSE. If unset, Arcade can be reused when `USE_ARCADE_CHAINTRACKS=true`. |
| CHAINTRACKS_API_PREFIX           | No            | Chaintracks API prefix. Defaults to `/chaintracks/v2` for Arcade-mounted Chaintracks.                                                     |
| USE_ARCADE_CHAINTRACKS           | No            | Reuse `ARCADE_URL` for Chaintracks when `CHAINTRACKS_URL` is unset. Defaults to true when `ARCADE_URL` is set.                            |
| THROW_ON_BROADCAST_FAIL          | No            | Reject overlay admission if no broadcast provider accepts the transaction. Defaults to `true`.                                            |
| MONGO_URL                        | Yes           | MongoDB connection string                                                                                                                 |
| KNEX_URL                         | Yes           | MySQL connection string for Knex                                                                                                          |
| GASP_ENABLED                     | No            | `true` or `false` (Graph Aware Sync Protocol for overlay sync)                                                                            |
| BASM_ENABLED                     | No            | Enable BRC-136 BASM synchronization. Defaults to `false`.                                                                                 |
| BASM_REORG_STREAM_ENABLED        | No            | Subscribe to Chaintracks reorg SSE when Chaintracks is configured. Defaults to `true`.                                                    |
| BASM_REORG_SCAN_DEPTH            | No            | Number of recent blocks to revalidate on reorg reconnect/poll.                                                                            |
| BASM_BLOCK_POLL_INTERVAL_MS      | No            | Interval for BASM anchor/header polling. Set to `0` to disable periodic polling.                                                          |
| UNPROVEN_EVICTION_BLOCKS         | No            | Block-age threshold for unproven transaction eviction.                                                                                    |
| UNPROVEN_MAINTENANCE_INTERVAL_MS | No            | Periodic refresh-then-evict cadence for unproven transactions. `0` disables periodic maintenance.                                         |
| LOG_LEVEL                        | No            | pino log level. Defaults to `info`.                                                                                                       |
| OTEL_*                           | No            | OpenTelemetry exporter/resource configuration. See `infra/OBSERVABILITY.md`.                                                              |

At least one transaction propagation provider must be configured:
`ARCADE_URL` or `ARC_API_KEY`. Production deployments should prefer
Arcade-first plus Arc fallback when both are available.

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
  -e ARCADE_URL=https://arcade-v2-us-1.bsvblockchain.tech \
  -e ARCADE_API_KEY=<arcade-key> \
  -e ARCADE_DEPLOYMENT_ID=overlay-node-1 \
  -e ARC_API_KEY=<arc-key> \
  -e ARC_CALLBACK_TOKEN=<callback-token> \
  -e USE_ARCADE_CHAINTRACKS=true \
  -e BASM_ENABLED=true \
  -e UNPROVEN_EVICTION_BLOCKS=144 \
  -e UNPROVEN_MAINTENANCE_INTERVAL_MS=3600000 \
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

## Provider and maintenance behavior

The deployment wrapper configures providers in this order:

1. Arcade, when `ARCADE_URL` is set.
2. Arc fallback, when `ARC_API_KEY` is set.
3. Chaintracks header validation and reorg support from `CHAINTRACKS_URL`, or from
   `ARCADE_URL` when `USE_ARCADE_CHAINTRACKS=true`.

`THROW_ON_BROADCAST_FAIL=true` is the production default. With that setting, a
submitted transaction is not committed to overlay state unless a provider accepts
it or reports it already known. Transient provider errors should be retried by the
client or caller; terminal provider errors are not treated as successful overlay
admission.

Provider callbacks posted to `/arc-ingest` are used to attach proofs or mark
terminal outcomes. Double-spend or terminal invalid callbacks evict the
transaction from admitted overlay state and notify lookup services through the
normal eviction path.

When `UNPROVEN_MAINTENANCE_INTERVAL_MS` is greater than zero, the server
periodically runs proof refresh followed by unproven eviction. The same behavior
is available manually through `POST /admin/maintainUnproven`.

## Health checks

Use:

- `GET /health/live` for Kubernetes liveness.
- `GET /health/ready` for readiness.
- `GET /health` for operator diagnostics.

The full health response includes provider context showing whether Arc, Arcade,
and Chaintracks are configured, plus BASM and unproven-maintenance settings.
Alert on readiness failures, repeated provider callback errors, repeated
`overlay.unproven_maintenance` failures, and increasing unproven transaction
counts.

## Spec conformance

- **Topic Manager Pattern** – Validates outputs via identifyAdmissibleOutputs() method
- **Lookup Service Pattern** – Stores/queries via outputAdmittedByTopic(), outputSpent(), lookup() methods
- **PushDrop (BRC-48)** – Standard output decoding format
- **GASP** – Graph Aware Sync Protocol for multi-node overlay synchronization (disable for simple local deployments)

## Integration with ts-stack

- Implements topic managers and lookup services from @bsv/sdk Transaction and PushDrop utilities
- Coordinates with WalletAdvertiser for overlay service advertisement
- Uses @bsv/overlay-express server configuration and routing
- Connects wallet operations to blockchain via Arcade, Arc, Chaintracks, and
  Wallet Storage
- Services registered in src/index.ts: tm_protomap, ls_protomap, tm_certmap, ls_certmap, tm_uhrp, ls_uhrp, etc.

## Common pitfalls

- Topic manager IDs must start with `tm_`, lookup service IDs with `ls_`
- Invalid outputs must be silently skipped in topic managers (don't throw errors)
- Lookup services use factory pattern returning instances from MongoDB connection
- GASP sync may cause conflicts if disabled on some nodes; keep consistent across deployment
- Admin API requires ADMIN_TOKEN in Authorization header; unauthenticated calls rejected
- Database indexes critical for performance with large transaction volumes
- Do not run BASM without a production chain tracker. `CHAINTRACKS_URL` or
  `USE_ARCADE_CHAINTRACKS=true` should be configured so anchors use canonical
  block headers and reorg handling.
- Keep `THROW_ON_BROADCAST_FAIL=true` unless the deployment intentionally accepts
  local overlay admission while broadcast providers are unavailable.
- Arcade-mounted Chaintracks uses `/chaintracks/v2`; a standalone go-chaintracks
  deployment may use a different prefix, so set `CHAINTRACKS_API_PREFIX`
  explicitly when needed.

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/overlay-server)
- [npm package](https://npmjs.com/package/@bsv/overlay-express)
