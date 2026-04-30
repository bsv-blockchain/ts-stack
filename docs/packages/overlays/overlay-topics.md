---
id: overlay-topics
title: "@bsv/overlay-topics"
kind: package
domain: overlays
npm: "@bsv/overlay-topics"
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["overlay", "topics", "uhrp"]
---

# @bsv/overlay-topics

> Canonical collection of pre-built BSV overlay topic managers and lookup services for identity, tokens, supply chain, messaging, and more.

## Install

```bash
npm install @bsv/overlay-topics
```

## Quick start

```typescript
import { HelloWorldTopicManager, createHelloWorldLookupService } from '@bsv/overlay-topics'
import { BTMSTopicManager, createBTMSLookupService } from '@bsv/overlay-topics'

const helloManager = new HelloWorldTopicManager()
const helloService = await createHelloWorldLookupService(mongoDb)

const btmsManager = new BTMSTopicManager()
const btmsService = await createBTMSLookupService(mongoDb)

const results = await btmsService.lookup({
  service: 'ls_btms',
  query: { assetId: 'txid.0' }
})
```

## What it provides

- **20+ topic managers** — Pre-built implementations (HelloWorld, DID, BTMS, KVStore, SupplyChain, UHRP, UMP, ProtoMap, and more)
- **Lookup service factories** — Each topic includes MongoDB-backed lookup service
- **Type-safe queries** — Each topic defines its own Query and Record types
- **PushDrop encoding** — All topics use standardized data encoding for consistency
- **Auto-indexing** — Lookup services auto-create MongoDB indices for efficient queries
- **Complete documentation** — Each topic includes metadata and protocol docs

## Common patterns

### Register multiple topics in OverlayExpress

```typescript
import OverlayExpress from '@bsv/overlay-express'
import {
  HelloWorldTopicManager, createHelloWorldLookupService,
  DIDTopicManager, createDIDLookupService,
  KVStoreTopicManager, createKVStoreLookupService,
  BTMSTopicManager, createBTMSLookupService
} from '@bsv/overlay-topics'

const server = new OverlayExpress('mynode', privateKey, 'https://example.com')

server.configureTopicManager('tm_hello', new HelloWorldTopicManager())
server.configureTopicManager('tm_did', new DIDTopicManager())
server.configureTopicManager('tm_kvstore', new KVStoreTopicManager())
server.configureTopicManager('tm_btms', new BTMSTopicManager())

await server.configureLookupServiceWithMongo('ls_hello', db => createHelloWorldLookupService(db))
await server.configureLookupServiceWithMongo('ls_did', db => createDIDLookupService(db))
await server.configureLookupServiceWithMongo('ls_kvstore', db => createKVStoreLookupService(db))
await server.configureLookupServiceWithMongo('ls_btms', db => createBTMSLookupService(db))

await server.configureEngine()
await server.start()
```

### Query by topic

```typescript
// DID query
const didResults = await didService.lookup({
  service: 'ls_did',
  query: { /* topic-specific */ }
})

// KVStore query
const kvResults = await kvService.lookup({
  service: 'ls_kvstore',
  query: { key: 'mykey', owner: '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366' }
})

// Supply chain query
const scResults = await scService.lookup({
  service: 'ls_supplychain',
  query: { productId: 'abc123' }
})
```

### Manual topic manager use

```typescript
const manager = new DIDTopicManager()
const admittance = await manager.identifyAdmissibleOutputs(beef, [])
// Expects 2-field PushDrop: [serialNumber, signature]
```

## Key concepts

- **Topic managers** — Validate which outputs are protocol-valid (implements TopicManager interface)
- **Lookup services** — Index and query admitted outputs in MongoDB (implements LookupService interface)
- **PushDrop encoding** — All topics use PushDrop format for structured data + signature/lock
- **Protocol-specific fields** — Each topic defines what fields it expects (e.g., DID requires [serialNumber, signature])
- **Query types** — Each topic defines type-safe Query and Record types
- **Lookup factories** — `create*LookupService(db)` functions are async and return configured services
- **MongoDB indexing** — Services auto-create indices on frequently-queried fields

## When to use this

- Running an overlay node with multiple topics
- Need pre-built, tested topic implementations
- Want standardized PushDrop encoding
- Building applications on top of overlay services
- Need token management (BTMS), identity (DID), or key-value storage

## When NOT to use this

- For custom protocol topics — implement TopicManager/LookupService directly
- If you don't need lookup queries — just use topic managers
- Without MongoDB backend — lookup services require MongoDB

## Spec conformance

- **DID** — W3C-compliant decentralized identifiers (serialNumber as DID identifier)
- **BTMS** — Basic Token Management System protocol (issuance, transfer, burn)
- **KVStore** — Key-value protocol-agnostic storage
- **ProtoMap** — Registry of wallet protocols with deserialization support
- **UHRP** — Unified Hash Registry Protocol
- **UMP** — Universal Messenger Protocol
- **All topics** — Use PushDrop encoding per @bsv/sdk

## Common pitfalls

1. **Lookup factories are async** — `create*LookupService()` returns Promise; must await
2. **MongoDB required** — All lookup services assume MongoDB; no Knex fallback
3. **PushDrop validation** — Each topic validates structure; malformed scripts are rejected
4. **Field count varies** — DID requires exactly 2 fields; BTMS requires 2-4; violations rejected
5. **BTMS asset semantics** — "ISSUE" = new token; otherwise must match previous issuance txid.outputIndex
6. **Signature validation** — Most topics verify signatures; invalid signatures cause rejection

## Available topics

- **any** — Catch-all topic accepting any PushDrop output
- **btms** — Basic Token Management System (token issuance/transfer)
- **apps** — Application catalog
- **basketmap** — Logical grouping of tokens
- **certmap** — Certificate mapping
- **desktopintegrity** — Desktop integrity verification
- **did** — Decentralized Identifiers
- **fractionalize** — Token fractionalization
- **hello** — Hello World demo topic
- **identity** — Identity attributes and claims
- **kvstore** — Key-value store
- **message-box** — Inbox/messaging
- **monsterbattle** — Game state (demo)
- **protomap** — Protocol registry
- **slackthreads** — Slack thread indexing
- **supplychain** — Supply chain tracking
- **uhrp** — Unified Hash Registry Protocol
- **ump** — Universal Messenger Protocol
- **utility-tokens** — Fungible token demo
- **walletconfig** — Wallet configuration

## Related packages

- [@bsv/overlay](./overlay.md) — Core Engine and interfaces
- [@bsv/overlay-express](./overlay-express.md) — HTTP server wrapper
- [@bsv/overlay-discovery-services](./overlay-discovery-services.md) — SHIP/SLAP peer discovery
- [@bsv/gasp](./gasp.md) — Graph Aware Sync Protocol

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/overlay-topics/)
- [Source on GitHub](https://github.com/bsv-blockchain/overlay-topics)
- [npm](https://www.npmjs.com/package/@bsv/overlay-topics)
