---
id: overlay-express
title: "@bsv/overlay-express"
kind: package
domain: overlays
npm: "@bsv/overlay-express"
version: "2.4.2"
last_updated: "2026-07-24"
last_verified: "2026-07-24"
status: stable
tags: ["overlay", "express", "http"]
---

# @bsv/overlay-express

> Opinionated Express.js HTTP server wrapper for @bsv/overlay with built-in configuration, health checks, and peer discovery.

## Install

```bash
npm install @bsv/overlay-express
```

## Quick start

```typescript
import OverlayExpress from '@bsv/overlay-express'

const server = new OverlayExpress(
  'testnode',
  process.env.SERVER_PRIVATE_KEY!,
  'example.com'
)

server.configurePort(8080)
await server.configureKnex(process.env.KNEX_URL!)
await server.configureMongo(process.env.MONGO_URL!)

server.configureTopicManager('tm_helloworld', new HelloWorldTopicManager())
await server.configureLookupServiceWithMongo('ls_helloworld', mongoDb =>
  createHelloWorldLookupService(mongoDb)
)

await server.configureEngine()
await server.start()
```

## What it provides

- **OverlayExpress** — One-stop configuration for building an overlay HTTP server
- **Configuration methods** — Simple fluent API for Knex, MongoDB, topic managers, lookup services
- **Health endpoints** — `/health/live`, `/health/ready`, `/health` with custom checks
- **Admin token** — Bearer token authentication for protected endpoints
- **Web UI** — Auto-generated documentation and service explorer
- **BanService** — Optional output banning by txid.outputIndex
- **JanitorService** — Health validation for SHIP/SLAP peer hosts
- **Provider chain** — Arcade-first broadcast/proof lookup with Arc fallback
- **Chaintracks integration** — Header resolution and reorg SSE for BASM
- **OverlayMonitor** — Lookup probes plus optional admin maintenance actions

## Common patterns

### Basic server setup

```typescript
const server = new OverlayExpress(
  'mynode',
  privateKey,
  'mynode.example.com'
)

server.configurePort(3000)
await server.configureKnex('postgresql://user:pass@localhost/db')
```

### Register multiple topics

```typescript
server.configureTopicManager('tm_helloworld', new HelloWorldTopicManager())
server.configureTopicManager('tm_kvstore', new KVStoreTopicManager())
server.configureTopicManager('tm_did', new DIDTopicManager())

await server.configureLookupServiceWithMongo('ls_helloworld', db => createHelloWorldLookupService(db))
await server.configureLookupServiceWithMongo('ls_kvstore', db => createKVStoreLookupService(db))
await server.configureLookupServiceWithMongo('ls_did', db => createDIDLookupService(db))

await server.configureEngine()
await server.start()
```

### Configure health checks

```typescript
server.configureHealth({
  contextProvider: async () => ({
    deployment: 'my-overlay',
    network: 'main'
  })
})

server.registerHealthCheck({
  name: 'custom-cache',
  critical: false,
  handler: async () => ({
    status: 'ok',
    details: { warmed: true }
  })
})
```

### Advanced engine options

```typescript
server.configureEngineParams({
  logTime: true,
  throwOnBroadcastFailure: true,
  suppressDefaultSyncAdvertisements: false
})

server.configureEnableGASPSync(true)
server.configureArcade(process.env.ARCADE_URL!, {
  apiKey: process.env.ARCADE_API_KEY,
  deploymentId: process.env.ARCADE_DEPLOYMENT_ID
})
server.configureArcApiKey(process.env.ARC_API_KEY!)
server.configureChaintracks(process.env.CHAINTRACKS_URL ?? process.env.ARCADE_URL!, {
  apiPrefix: '/chaintracks/v2',
  reorgStream: true,
  scanDepth: 3
})
server.configureEnableBASMSync(true)
server.configureUnprovenMaintenance({
  thresholdBlocks: 144,
  intervalMs: 60 * 60 * 1000
})
server.configureWebUI({
  host: 'https://example.com',
  primaryColor: '#ff0000'
})
```

### Monitor an overlay deployment

```typescript
import { OverlayMonitor } from '@bsv/overlay-express'

const monitor = new OverlayMonitor({
  intervalMs: 60 * 60 * 1000,
  targets: [{
    name: 'production-overlay',
    baseUrl: 'https://overlay.example',
    adminToken: process.env.ADMIN_TOKEN,
    probes: [{
      name: 'protomap',
      service: 'ls_protomap',
      query: { topic: 'tm_protomap' },
      maxOutputs: 50
    }],
    maintenance: {
      startBASMSync: true,
      maintainUnproven: { thresholdBlocks: 144 },
      janitor: true
    }
  }]
})

monitor.start()
```

## Key concepts

- **OverlayExpress** — Wraps Engine in Express with all routes auto-configured
- **Private key** — Identifies the overlay node; used for signing advertisements and transactions
- **Advertising FQDN** — Domain where this node is hosted; advertised in SHIP/SLAP for peer discovery
- **Admin token** — Bearer token for protected endpoints (`/admin/syncAdvertisements`, `/admin/startGASPSync`)
- **Knex vs MongoDB** — Knex for SQL (global application storage), MongoDB for per-service indices
- **Health endpoints** — Follow Kubernetes liveness/readiness probe patterns
- **JanitorService** — Periodically validates SHIP/SLAP hosts; revokes failing entries
- **Provider callbacks** — `/arc-ingest` accepts Arc/Arcade callback notifications,
  applies proofs, and evicts terminal invalid or double-spent transactions
- **Unproven maintenance** — Proof refresh runs before eviction so mined
  transactions can recover before stale unproven rows are removed

## When to use this

- Deploying an overlay service to production
- Running a node that serves multiple topics/lookup services
- Need built-in health checks and monitoring
- Want auto-generated web UI for service discovery
- Scaling lookup services with MongoDB indices

## When NOT to use this

- For simple single-topic overlays without HTTP exposure
- If you need custom HTTP framework (use @bsv/overlay directly)
- For development without persistence (use @bsv/overlay in-memory)

## Spec conformance

- Implements BSV Overlay protocol with SHIP/SLAP peer discovery
- Supports Graph Aware Sync Protocol (GASP) for historical sync
- Health endpoints follow Kubernetes liveness/readiness probe patterns
- Optional Arc and Arcade callback integration for proof-of-inclusion on mainnet
- Chaintracks-compatible header and reorg handling for BRC-136 BASM

## Common pitfalls

1. **Initialization order** — `configureKnex` and `configureMongo` must complete before `configureEngine()`
2. **Admin token** — Auto-generated if not provided; store securely for production
3. **Health check criticality** — Mark as `critical: true` only for mandatory dependencies; failures block `/health/ready`
4. **GASP sync overhead** — Disabling sync useful for dev but loses peer synchronization
5. **BanService persistence** — Bans not persisted if MongoDB goes down; transient storage only
6. **Strict broadcast** — Keep `throwOnBroadcastFailure: true` for production so
   provider outages do not create local-only overlay state.
7. **BASM dependencies** — BASM should use a Chaintracks-compatible chain tracker;
   Arcade exposes this under `/chaintracks/v2`.

## Related packages

- [@bsv/overlay](./overlay.md) — Core Engine and interfaces
- [@bsv/overlay-topics](./overlay-topics.md) — Pre-built topic managers and lookup services
- [@bsv/overlay-discovery-services](./overlay-discovery-services.md) — SHIP/SLAP implementation
- [@bsv/gasp](./gasp.md) — Graph Aware Sync Protocol

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/overlay-express/)
- [Source on GitHub](https://github.com/bsv-blockchain/overlay-express)
- [npm](https://www.npmjs.com/package/@bsv/overlay-express)
