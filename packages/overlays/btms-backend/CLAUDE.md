# CLAUDE.md — @bsv/btms-backend

## Purpose

BTMS Backend provides overlay services for the Basic Token Management System — a UTXO-based token protocol on BSV. Includes topic manager for token validation and lookup service for indexing/querying token state. Note: Core token definitions recently moved to `@bsv/overlay-topics/src/btms/`; this package may now be a thin shell or deprecated in favor of that location.

## Public API surface

From `mod.ts`:

- **`BTMSTopicManager`** (default export) — Token validation and admission
  - `identifyAdmissibleOutputs(beef, previousCoins)` → `Promise<AdmittanceInstructions>`
  - `getDocumentation()` → `Promise<string>`
  - `getMetaData()` → `Promise<{name, shortDescription, version?, iconURL?, informationURL?}>`

- **`BTMSLookupServiceFactory`** (default export from lookup-services) — Factory for lookup service
  - Signature: `createBTMSLookupService(mongoDb: Db) → Promise<LookupService>`

- **Types from `src/types.ts`**:
  - `BTMSQuery` — Query shape for token lookups
  - `BTMSRecord` — Token record in storage
  - `BTMSLookupResult` — Result from lookup queries

## Real usage patterns

From README and tests:

```typescript
// 1. Using BTMSTopicManager
import { BTMSTopicManager } from '@bsv/btms-backend'

const topicManager = new BTMSTopicManager()

// Validate a transaction
const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)
// Returns: { outputsToAdmit: [0, 1], coinsToRetain: [] }

// 2. Using BTMSLookupServiceFactory
import BTMSLookupServiceFactory from '@bsv/btms-backend'
import { MongoClient } from 'mongodb'

const client = new MongoClient('mongodb://localhost:27017')
await client.connect()
const db = client.db('btms')

const lookupService = await BTMSLookupServiceFactory(db)

// 3. Querying tokens by asset ID
const results = await lookupService.lookup({
  service: 'ls_btms',
  query: { assetId: 'txid.0' }
})

// 4. Querying tokens by owner public key
const ownerResults = await lookupService.lookup({
  service: 'ls_btms',
  query: { ownerKey: '03abc123...' }
})

// 5. Registering in OverlayExpress
import OverlayExpress from '@bsv/overlay-express'
import { BTMSTopicManager, BTMSLookupServiceFactory } from '@bsv/btms-backend'

const server = new OverlayExpress('mynode', privateKey, 'https://example.com')

server.configureTopicManager('tm_btms', new BTMSTopicManager())
await server.configureLookupServiceWithMongo('ls_btms', db => 
  BTMSLookupServiceFactory(db)
)

await server.configureEngine()
await server.start()

// 6. Direct access to topic and lookup documentation
const manager = new BTMSTopicManager()
const docs = await manager.getDocumentation()
const metadata = await manager.getMetaData()
// metadata = { name: 'btms', shortDescription: '...', version: '0.1.0', ... }
```

## Key concepts

- **Token issuance**: Outputs with assetId = "ISSUE" create new tokens; subsequent transfers reference these via `txid.outputIndex`
- **Token protocol**: PushDrop-encoded with fields [assetIdField, amount, metadata?]
  - assetIdField: "ISSUE" or "txid.outputIndex" reference
  - amount: Numeric string representing token quantity
  - metadata: Optional UTF-8 string (optional 3rd field)
- **Validation rules**:
  1. Issuance: assetId = "ISSUE"
  2. Transfer: Output amounts cannot exceed input amounts for same asset
  3. Metadata: Remains consistent across transfers if set during issuance
  4. Splitting: Tokens can be divided into multiple outputs
  5. Merging: Multiple tokens of same asset can be combined
  6. Burning: Tokens spent without corresponding outputs are destroyed
- **Lookup queries**: By assetId or ownerKey; auto-creates MongoDB indices
- **Storage**: MongoDB with auto-indexing on assetId, ownerKey, {txid, outputIndex}

## Dependencies

**Runtime:**
- `@bsv/overlay` — TopicManager, LookupService interfaces, AdmittanceInstructions
- `@bsv/sdk` — Transaction, LockingScript, PushDrop, PrivateKey, Utils
- `mongodb` — MongoDB driver (for lookup service)

**Dev:**
- jest, ts-jest, typescript, ts-standard
- mongodb-memory-server — In-memory MongoDB for tests

## Common pitfalls / gotchas

1. **Asset ID semantics**: "ISSUE" = new token; any other value must match previous issuance txid.outputIndex
2. **Amount validation**: Must be numeric string and >= 1; non-numeric or negative amounts rejected
3. **Metadata detection**: If field 3 looks like a signature (binary, non-UTF8), it's treated as signature, not metadata
4. **Lookup factory is async**: `BTMSLookupServiceFactory()` returns a Promise; must await
5. **MongoDB required**: No Knex fallback; requires MongoDB for lookup service
6. **Conservation law**: Sum of input amounts per asset must >= sum of output amounts; violates rejected
7. **Field count**: Accepts 2-4 PushDrop fields ([assetId, amount, metadata?, signature?])
8. **Deprecation note**: Core BTMS definitions now at `@bsv/overlay-topics/src/btms/`; this package may be shell or deprecated

## Spec conformance

- **BTMS Protocol**: Basic Token Management System (BSV token standard)
- **PushDrop encoding**: Uses PushDrop for locking script structure
- **Token conservation**: Enforces that total output amount <= total input amount per asset
- **Metadata persistence**: Optional metadata tracked across all token transfers

## File map

```
src/
├── topic-managers/
│   ├── BTMSTopicManager.ts      — Token validation logic
│   └── __tests__/
│       └── BTMSTopicManager.test.ts
├── lookup-services/
│   ├── BTMSLookupServiceFactory.ts  — Factory for creating lookup service
│   ├── BTMSStorageManager.ts        — MongoDB storage/indexing
│   ├── types.ts                     — Query/Record/Result types
│   ├── docs/
│   │   ├── BTMSTopicManagerDocs.ts  — Topic manager protocol docs
│   │   └── BTMSLookupDocs.ts        — Lookup service protocol docs
│   └── __tests__/
│       └── [Test files]
├── types.ts                     — Exported types (BTMSQuery, BTMSRecord, BTMSLookupResult)
└── docs/
    ├── BTMSTopicManagerDocs.ts  — Protocol documentation
    └── BTMSLookupDocs.ts        — Lookup service documentation
mod.ts                           — Main exports
```

## Integration points

- **@bsv/overlay**: Implements TopicManager/LookupService interfaces; Engine uses to validate/index tokens
- **@bsv/overlay-express**: Registered via `configureTopicManager('tm_btms', ...)` and `configureLookupServiceWithMongo('ls_btms', ...)`
- **@bsv/overlay-topics**: Core BTMS definitions and implementations now located here; this package may reference or wrap them
- **@bsv/sdk**: Uses PushDrop, Transaction, PrivateKey for token encoding/decoding
- **MongoDB**: Persistent storage for token UTXOs and query indices
