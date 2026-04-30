---
id: pkg-btms-backend
title: "@bsv/btms-backend"
kind: package
domain: overlays
version: "0.1.0"
source_repo: "bsv-blockchain/btms-backend"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/btms-backend"
repo: "https://github.com/bsv-blockchain/btms-backend"
status: experimental
tags: [tokens, btms, backend, mongodb]
---

# @bsv/btms-backend

> BTMS (Basic Token Management System) overlay services — topic manager and lookup service for token validation and indexing.

**Note:** Core BTMS definitions have been consolidated into [@bsv/overlay-topics](./overlay-topics.md). This package may be transitional or legacy; prefer using @bsv/overlay-topics directly for new projects.

## Install

```bash
npm install @bsv/btms-backend
```

## Quick start

```typescript
import { BTMSTopicManager, BTMSLookupServiceFactory } from '@bsv/btms-backend'
import { MongoClient } from 'mongodb'

const client = new MongoClient('mongodb://localhost:27017')
await client.connect()
const db = client.db('btms')

const topicManager = new BTMSTopicManager()

// Validate a transaction
const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)
// Returns: { outputsToAdmit: [0, 1], coinsToRetain: [] }

// Create lookup service
const lookupService = await BTMSLookupServiceFactory(db)

// Query tokens by asset ID
const results = await lookupService.lookup({
  service: 'ls_btms',
  query: { assetId: 'txid.0' }
})
```

## What it provides

- **BTMSTopicManager** — Validates token transactions (issuance, transfer, burn)
- **BTMSLookupServiceFactory** — Factory for creating MongoDB-backed lookup service
- **Token validation** — Enforces BTMS protocol rules (conservation, metadata consistency)
- **Query by asset ID** — Find all tokens for a specific asset
- **Query by owner** — Find tokens owned by a public key
- **MongoDB storage** — Auto-creates indices for efficient queries
- **Type-safe queries** — BTMSQuery, BTMSRecord, BTMSLookupResult types

## Common patterns

### Register in OverlayExpress

```typescript
import OverlayExpress from '@bsv/overlay-express'
import { BTMSTopicManager, BTMSLookupServiceFactory } from '@bsv/btms-backend'

const server = new OverlayExpress('mynode', privateKey, 'example.com')

server.configureTopicManager('tm_btms', new BTMSTopicManager())
await server.configureLookupServiceWithMongo('ls_btms', db => 
  BTMSLookupServiceFactory(db)
)

await server.configureEngine()
await server.start()
```

### Query tokens by owner

```typescript
const ownerResults = await lookupService.lookup({
  service: 'ls_btms',
  query: { ownerKey: '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366' }
})
```

### Retrieve metadata

```typescript
const manager = new BTMSTopicManager()
const docs = await manager.getDocumentation()
const metadata = await manager.getMetaData()
// metadata = { name: 'btms', shortDescription: '...', version: '0.1.0', ... }
```

## Key concepts

- **Token issuance** — Outputs with assetId = "ISSUE" create new tokens; subsequent transfers reference via `txid.outputIndex`
- **Token protocol** — PushDrop-encoded with fields `[assetIdField, amount, metadata?]`
- **Conservation law** — Sum of input amounts per asset must be >= sum of output amounts (tokens can be burned)
- **Metadata persistence** — Optional metadata remains consistent across all transfers if set during issuance
- **Validation modes** — Issuance vs Transfer validation ensures protocol integrity

## When to use this

- Running a BTMS overlay node in production
- Need token metadata and discovery services
- Building a token registry or explorer
- Implementing token-based applications with persistent storage
- Synchronizing token state across nodes with GASP

## When NOT to use this

- For client-side token operations — use @bsv/sdk directly
- If you don't need persistent storage — use @bsv/overlay-topics without lookup
- For non-token overlays — use @bsv/overlay or @bsv/overlay-topics for other topics
- New projects should prefer [@bsv/overlay-topics](./overlay-topics.md) BTMS implementation

## Spec conformance

- **BTMS Protocol** — Basic Token Management System (BSV token standard)
- **PushDrop encoding** — Uses PushDrop format per @bsv/sdk
- **Token conservation** — Enforces that output amounts <= input amounts per asset
- **Metadata persistence** — Optional metadata tracked across all token transfers

## Common pitfalls

1. **Asset ID semantics** — "ISSUE" = new token; other values must match previous issuance txid.outputIndex
2. **Amount validation** — Must be numeric string and >= 1; non-numeric or negative rejected
3. **Lookup factory is async** — `BTMSLookupServiceFactory()` returns Promise; must await
4. **MongoDB required** — No Knex fallback; requires MongoDB for lookup service
5. **Conservation law** — Sum of input amounts per asset must >= sum of output amounts
6. **Field count** — Accepts 2-4 PushDrop fields ([assetId, amount, metadata?, signature?])
7. **Deprecation** — Core BTMS definitions now at [@bsv/overlay-topics](./overlay-topics.md); prefer that for new projects

## Related packages

- [@bsv/overlay-topics](./overlay-topics.md) — Canonical BTMS implementation (preferred for new projects)
- [@bsv/overlay](./overlay.md) — Core Engine that uses this topic manager
- [@bsv/overlay-express](./overlay-express.md) — HTTP server wrapper
- [@bsv/gasp](./gasp.md) — Synchronize token state between nodes

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/btms-backend/)
- [Source on GitHub](https://github.com/bsv-blockchain/btms-backend)
- [npm](https://www.npmjs.com/package/@bsv/btms-backend)
