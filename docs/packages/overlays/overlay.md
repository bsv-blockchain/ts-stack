---
id: overlay
title: "@bsv/overlay"
kind: package
domain: overlays
npm: "@bsv/overlay"
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["overlay", "framework"]
---

# @bsv/overlay

> Core library defining the Overlay Services Engine for UTXO-based systems on BSV.

## Install

```bash
npm install @bsv/overlay
```

## Quick start

```typescript
import { Engine } from '@bsv/overlay'
import { KnexStorage } from '@bsv/overlay'
import { WhatsOnChain } from '@bsv/sdk'

// Create and configure an Engine
const engine = new Engine(
  { hello: new HelloTopicManager() },
  { hello: new HelloLookupService({ storageEngine: new HelloStorageEngine({ knex }) }) },
  new KnexStorage({ knex }),
  new WhatsOnChain('main', { httpClient: new NodejsHttpClient(https) }),
  'https://example.com'
)

// Submit transactions with topics
const topics = JSON.parse(req.headers['x-topics'])
const taggedBEEF = { beef: Array.from(req.body), topics }
await engine.submit(taggedBEEF, (steak) => res.status(200).json(steak))

// Perform lookups
const result = await engine.lookup({
  service: 'ls_hello',
  query: { /* topic-specific query */ }
})
```

## What it provides

- **Engine** — Orchestrates topic managers and lookup services, handles transaction submission and UTXO history
- **TopicManager** — Interface for implementing admission logic (validates which outputs belong to your overlay)
- **LookupService** — Interface for indexing and querying admitted UTXOs
- **Storage** — Abstracted persistence layer with Knex-based SQL implementation
- **BEEF/STEAK encoding** — Transaction encoding (BEEF = Bitcoins Efficiently Formatted; STEAK = engine response format)
- **GASP Integration** — Syncs with other overlay services using Graph Aware Sync Protocol
- **SHIP/SLAP support** — Built-in peer discovery protocols

## Common patterns

### Implementing a TopicManager

```typescript
class CustomTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef, previousCoins) {
    const tx = new Transaction(beef)
    return { outputsToAdmit: [0], coinsToRetain: [] }
  }
  
  async getDocumentation() { 
    return 'Custom topic documentation' 
  }
  
  async getMetaData() { 
    return { 
      name: 'custom', 
      shortDescription: 'A custom topic' 
    } 
  }
}
```

### Implementing a LookupService

```typescript
class CustomLookupService implements LookupService {
  readonly admissionMode = 'locking-script'
  readonly spendNotificationMode = 'none'
  
  async outputAdmittedByTopic(payload) {
    if (payload.mode === 'locking-script') {
      // Index the output
    }
  }
  
  async lookup(question) {
    // Return LookupFormula with results
    return { UTXOs: [...] }
  }
}
```

### Configuring storage with Knex

```typescript
const storage = new KnexStorage({ knex })
// Migrations automatically applied for SQLite/PostgreSQL/MySQL
```

## Key concepts

- **TopicManager** — Validates which outputs are admissible to the overlay based on protocol rules
- **LookupService** — Indexes and queries admitted UTXOs; notified on admission/spend/eviction
- **AdmissionMode** — Whether lookup service receives locking-script details (`'locking-script'`) or whole transaction (`'whole-tx'`)
- **SpendNotificationMode** — How lookup service is notified when a UTXO is spent (`'none'`, `'txid'`, `'script'`, or `'whole-tx'`)
- **Storage** — Abstracted persistence layer; Knex implementation handles SQL migrations automatically
- **GASP** — Graph Aware Sync Protocol for inter-service synchronization

## When to use this

- Building an indexing service for a specific category of transactions
- Implementing custom business logic for transaction admission
- Creating a queryable ledger of on-chain data
- Syncing overlay state with other nodes

## When NOT to use this

- For simple transaction broadcast — use @bsv/teranode-listener
- For client-side token operations — use @bsv/sdk or @bsv/overlay-topics directly
- For non-blockchain applications — use traditional databases

## Spec conformance

- Implements BSV Overlay protocol for UTXO tracking
- Supports SHIP (Service Host Interconnect Protocol) and SLAP (Service Lookup Availability Protocol) for peer discovery
- Integrates Graph Aware Sync Protocol (GASP) for historical synchronization with other overlay nodes

## Common pitfalls

1. **Topic vs Service naming** — Topic managers are prefixed `tm_*`, lookup services `ls_*` by default in discovery
2. **BEEF encoding required** — All transactions must be submitted in BEEF format; raw hex will fail
3. **Knex migrations** — Custom storage implementations must handle schema creation; KnexStorage provides standard migrations
4. **GASP sync context** — SHIP/SLAP topics have special handling for peer discovery configuration
5. **Chain validation** — If chainTracker is 'scripts only', SPV proofs are not validated; unsafe for production

## Related packages

- [@bsv/overlay-express](./overlay-express.md) — HTTP server wrapper for Engine
- [@bsv/overlay-topics](./topics.md) — Pre-built topic managers and lookup services
- [@bsv/overlay-discovery-services](./overlay-discovery-services.md) — SHIP/SLAP peer discovery
- [@bsv/gasp](./gasp-core.md) — Graph Aware Sync Protocol

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/overlay/)
- [Source on GitHub](https://github.com/bsv-blockchain/overlay)
- [npm](https://www.npmjs.com/package/@bsv/overlay)
