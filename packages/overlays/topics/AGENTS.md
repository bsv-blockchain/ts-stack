# CLAUDE.md — @bsv/overlay-topics

## Purpose

Canonical collection of pre-built BSV overlay topic managers and lookup services. Ships ready-to-use implementations for common use cases (identity, tokens, supply chain, messaging, etc.), eliminating boilerplate for deploying overlay services.

## Public API surface

From `src/index.ts` — exports 20+ topic/lookup service pairs:

**Core types:**
- `UTXOReference` — Shared reference type

**any** — Catch-all topic accepting any PushDrop output
- `AnyTopicManager` — Admits any valid PushDrop
- `createAnyLookupService(db)` — Factory for MongoDB lookup
- Types: `AnyRecord`, `AnyQuery`

**btms** — Basic Token Management System (moved from btms-backend)
- `BTMSTopicManager` — Token issuance/transfer validation
- `createBTMSLookupService(db)` — Token indexing/query
- Types: `BTMSQuery`, `BTMSRecord`, `BTMSLookupResult`; `btmsProtocol` constant

**apps** — Application catalog
- `AppsTopicManager`, `createAppsLookupService(db)`
- Types: `AppCatalogQuery`, `PublishedAppMetadata`, `AppCatalogRecord`

**basketmap** — Logical grouping of tokens
- `BasketMapTopicManager`, `createBasketMapLookupService(db)`
- Types: `BasketMapRegistration`, `BasketMapRecord`, `BasketMapQuery`

**certmap** — Certificate mapping
- `CertMapTopicManager`, `createCertMapLookupService(db)`
- Types: `CertMapRegistration`, `CertMapRecord`, `CertMapQuery`

**desktopintegrity** — Desktop integrity verification
- `DesktopIntegrityTopicManager`, `createDesktopIntegrityLookupService(db)`
- Type: `DesktopIntegrityRecord`

**did** — Decentralized Identifiers
- `DIDTopicManager`, `createDIDLookupService(db)`
- Types: `DIDRecord`, `DIDQuery`

**fractionalize** — Token fractionalization
- `FractionalizeTopicManager`, `createFractionalizeLookupService(db)`
- Types: `FractionalizeRecord`, `FractionalizeQuery`

**hello** — Hello World demo topic
- `HelloWorldTopicManager`, `createHelloWorldLookupService(db)`
- Type: `HelloWorldRecord`

**identity** — Identity attributes/claims
- `IdentityTopicManager`, `createIdentityLookupService(db)`
- Types: `IdentityAttributes`, `IdentityRecord`, `IdentityQuery`

**kvstore** — Key-value store (protocol-agnostic)
- `KVStoreTopicManager`, `createKVStoreLookupService(db)`
- Types: `KVStoreQuery`, `KVStoreRecord`, `KVStoreLookupResult`; `kvProtocol` constant

**message-box** — Inbox/messaging
- `MessageBoxTopicManager`, `createMessageBoxLookupService(db)`

**monsterbattle** — Game state (demo app)
- `MonsterBattleTopicManager`, `createMonsterBattleLookupService(db)`
- Type: `MonsterBattleRecord`

**protomap** — Protocol registry
- `ProtoMapTopicManager`, `deserializeWalletProtocol()`, `createProtoMapLookupService(db)`
- Types: `ProtoMapRegistration`, `ProtoMapRecord`, `ProtoMapQuery`

**slackthreads** — Slack thread indexing
- `SlackThreadsTopicManager`, `createSlackThreadsLookupService(db)`
- Type: `SlackThreadRecord`

**supplychain** — Supply chain tracking
- `SupplyChainTopicManager`, `createSupplyChainLookupService(db)`
- Type: `SupplyChainRecord`

**uhrp** — Unified Hash Registry Protocol
- `UHRPTopicManager`, `createUHRPLookupService(db)`
- Type: `UHRPRecord`

**ump** — Universal Messenger Protocol
- `UMPTopicManager`, `createUMPLookupService(db)`
- Type: `UMPRecord`

**utility-tokens** — Fungible/NFT demo
- `TokenDemoTopicManager`, `createTokenDemoLookupService(db)`
- Types: `TokenDemoDetails`, `TokenDemoRecord`, `TokenDemoQuery`

**walletconfig** — Wallet configuration
- `WalletConfigTopicManager`, `createWalletConfigLookupService(db)`
- Types: `WalletConfigRegistration`, `WalletConfigRecord`, `WalletConfigQuery`

## Real usage patterns

From test files:

```typescript
// 1. Using HelloWorld topic
import { HelloWorldTopicManager, createHelloWorldLookupService } from '@bsv/overlay-topics'

const manager = new HelloWorldTopicManager()
const result = await manager.identifyAdmissibleOutputs(beef, previousCoins)

// Create lookup service (needs MongoDB Db instance)
const lookupService = await createHelloWorldLookupService(mongoDb)
const results = await lookupService.lookup({
  service: 'ls_hello',
  query: { /* topic-specific */ }
})

// 2. Using DID topic
import { DIDTopicManager, createDIDLookupService } from '@bsv/overlay-topics'

const didManager = new DIDTopicManager()
const admittance = await didManager.identifyAdmissibleOutputs(beef, [])
// Expects 2-field PushDrop: [serialNumber, signature]

// 3. Using BTMS (token management)
import { BTMSTopicManager, createBTMSLookupService, BTMSQuery } from '@bsv/overlay-topics'

const btmsManager = new BTMSTopicManager()
const btmsService = await createBTMSLookupService(mongoDb)
const tokens = await btmsService.lookup({
  service: 'ls_btms',
  query: { assetId: 'txid.0' } as BTMSQuery
})

// 4. Using KVStore
import { KVStoreTopicManager, createKVStoreLookupService, kvProtocol } from '@bsv/overlay-topics'

const kvManager = new KVStoreTopicManager()
const kvService = await createKVStoreLookupService(mongoDb)
// Query by key, owner, etc.

// 5. Registering multiple managers in OverlayExpress
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

## Key concepts

- **Topic managers**: Each implements `TopicManager` interface, deciding which outputs are protocol-valid
- **Lookup services**: Each implements `LookupService` interface, indexing and querying admitted outputs in MongoDB
- **PushDrop encoding**: All topics use PushDrop format for data fields + signature/lock structure
- **Protocol-specific fields**: Each topic defines what fields it expects (e.g., DID expects [serialNumber, signature], BTMS expects [assetId, amount, metadata?])
- **Query types**: Each topic defines its own `Query` and `Record` types for type-safe lookups
- **Lookup factories**: `create*LookupService(db)` functions that build and return configured services
- **MongoDB indexing**: All services auto-create indices on frequently-queried fields
- **Canonical exports**: All managers and services exported from index.ts for convenience

## Dependencies

**Runtime:**
- `@bsv/overlay` — TopicManager, LookupService interfaces
- `@bsv/sdk` — Transaction, LockingScript, PushDrop, PrivateKey, Signature, Utils
- `mongodb` — MongoDB driver (for lookup services)

**Dev:**
- jest, ts-jest, typescript, ts-standard
- mongodb-memory-server — In-memory MongoDB for tests

## Common pitfalls / gotchas

1. **Lookup factories are async**: `createHelloWorldLookupService()` returns a Promise; must await
2. **MongoDB required**: All lookup services assume a MongoDB connection; no fallback to Knex
3. **PushDrop validation**: Each topic validates PushDrop structure; malformed scripts are rejected
4. **Field count varies**: DID requires exactly 2 fields; BTMS requires 2-4 fields; violations are rejected
5. **Signature validation**: Most topics verify signatures; invalid signatures cause rejection
6. **BTMS asset ID semantics**: "ISSUE" in assetId field = new token; otherwise must match previous issuance
7. **Metadata fields**: Some topics (BTMS, Certmap) have optional metadata; must handle both presence and absence
8. **Topic naming conventions**: By convention, managers prefixed `tm_*`, services `ls_*` (e.g., `tm_btms`, `ls_btms`)

## Spec conformance

- **DID**: DIDs as per W3C patterns (serialNumber as DID identifier)
- **BTMS**: Basic Token Management System protocol (issuance, transfer, burn)
- **KVStore**: Key-value protocol-agnostic; supports arbitrary key-value pairs
- **ProtoMap**: Registry of wallet protocols; supports deserialization via `deserializeWalletProtocol()`
- **UHRP**: Unified Hash Registry Protocol
- **UMP**: Universal Messenger Protocol
- **All**: Use PushDrop for encoding (see @bsv/sdk)

## File map

```
src/
├── index.ts                  — All exports (20+ managers and services)
├── any/
│   ├── types.ts
│   ├── AnyTopicManager.ts
│   └── AnyLookupService.ts
├── btms/
│   ├── types.ts
│   ├── BTMSTopicManager.ts
│   └── BTMSLookupService.ts
├── apps/, basketmap/, certmap/, desktopintegrity/, did/, fractionalize/, hello/
│   identity/, kvstore/, message-box/, monsterbattle/, protomap/, slackthreads/
│   supplychain/, uhrp/, ump/, utility-tokens/, walletconfig/
│   └── [Similar structure: types.ts, TopicManager.ts, LookupService.ts]
└── __tests__/
    └── [Test files for each topic: hello.test.ts, did.test.ts, btms.test.ts, etc.]
```

## Integration points

- **@bsv/overlay**: Implements TopicManager/LookupService interfaces
- **@bsv/overlay-express**: Register managers/services via `configureTopicManager()` and `configureLookupServiceWithMongo()`
- **@bsv/overlay-discovery-services**: SHIP/SLAP can advertise any of these topics for peer discovery
- **@bsv/gasp**: Any topic can participate in Graph Aware Sync if Engine is configured for GASP
- **Custom topics**: Can be implemented separately and registered alongside these canonical ones
