# CLAUDE.md — @bsv/overlay

## Purpose

Core library defining the Overlay Services Engine for UTXO-based systems on BSV. Provides abstract `TopicManager` and `LookupService` interfaces, the `Engine` orchestrator, and Knex-based persistent storage. Enables dynamic tracking and management of applications built on top of the BSV blockchain.

## Public API surface

From `mod.ts`:

- **`Engine`** — Class that orchestrates topic managers and lookup services
  - Constructor: `new Engine(managers, lookupServices, storage, chainTracker, hostingURL, shipTrackers, slapTrackers, broadcaster, advertiser, syncConfiguration, logTime, logPrefix, throwOnBroadcastFailure, overlayBroadcastFacilitator, logger, suppressDefaultSyncAdvertisements)`
  - Methods: `submit(taggedBEEF, callback)`, `lookup(question)`, `listTopicManagers()`, `listLookupServiceProviders()`, `getDocumentationForTopicManger()`, `getDocumentationForLookupServiceProvider()`, `handleNewMerkleProof()`, `provideForeignSyncResponse()`, `provideForeignGASPNode()`

- **`TopicManager`** — Interface for admission logic
  - `identifyAdmissibleOutputs(beef, previousCoins, offChainValues?, mode?)` → `Promise<AdmittanceInstructions>`
  - `identifyNeededInputs?(beef, offChainValues?)` → `Promise<{txid, outputIndex}[]>`
  - `getDocumentation()` → `Promise<string>`
  - `getMetaData()` → `Promise<{name, shortDescription, iconURL?, version?, informationURL?}>`

- **`LookupService`** — Interface for querying admitted UTXOs
  - Properties: `admissionMode` ('locking-script' | 'whole-tx'), `spendNotificationMode` ('none' | 'txid' | 'script' | 'whole-tx')
  - Hooks: `outputAdmittedByTopic(payload)`, `outputSpent?(payload)`, `outputNoLongerRetainedInHistory?()`, `outputEvicted()`
  - Query: `lookup(question)` → `Promise<LookupFormula>`
  - Docs: `getDocumentation()`, `getMetaData()`

- **`Storage`** — Persistent storage interface (from storage/Storage.ts)
  - Methods for storing/retrieving transactions, UTXOs, outputs, admission records

- **`KnexStorage`** — Knex-based SQL storage implementation
  - Automatic migrations for SQLite/PostgreSQL/MySQL
  - Exports: `KnexStorageMigrations`

- **Types**: `TaggedBEEF`, `STEAK`, `LookupQuestion`, `LookupAnswer`, `AdmittanceInstructions`, `Output`, `LookupFormula`, `Advertisement`, `AdvertisementData`, `Advertiser`

## Real usage patterns

From README examples and test files:

```typescript
// 1. Creating and configuring an Engine
const engine = new Engine(
  { hello: new HelloTopicManager() },
  { hello: new HelloLookupService({ storageEngine: new HelloStorageEngine({ knex }) }) },
  new KnexStorage({ knex }),
  new WhatsOnChain('main', { httpClient: new NodejsHttpClient(https) }),
  'https://example.com'
)

// 2. Submitting transactions with topics
const topics = JSON.parse(req.headers['x-topics'])
const taggedBEEF = { beef: Array.from(req.body), topics }
await engine.submit(taggedBEEF, (steak) => res.status(200).json(steak))

// 3. Performing lookups
const result = await engine.lookup({
  service: 'ls_hello',
  query: { /* topic-specific query */ }
})

// 4. Implementing a TopicManager
class CustomTopicManager implements TopicManager {
  async identifyAdmissibleOutputs(beef, previousCoins) {
    const tx = new Transaction(beef)
    return { outputsToAdmit: [0], coinsToRetain: [] }
  }
  async getDocumentation() { return 'Custom topic' }
  async getMetaData() { return { name: 'custom', shortDescription: 'A custom topic' } }
}

// 5. Implementing a LookupService
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

## Key concepts

- **TopicManager**: Validates which outputs are admissible to the overlay based on protocol rules
- **LookupService**: Indexes and queries admitted UTXOs; notified on admission/spend/eviction
- **Engine**: Orchestrates managers/services, handles transaction submission, UTXO history, SHIP/SLAP sync, GASP integration
- **Storage**: Abstracted persistence layer; Knex implementation handles SQL migrations
- **BEEF/STEAK**: Transaction encoding (BEEF = Bitcoins Efficiently Formatted; STEAK = payload format for engine responses)
- **AdmissionMode**: Whether lookup service receives locking-script details or whole transaction
- **SpendNotificationMode**: How lookup service is notified when a UTXO is spent (none, txid-only, full script, whole-tx)
- **GASP Integration**: Engine can sync with other overlay services using Graph Aware Sync Protocol
- **SHIP/SLAP**: Sync protocols for peer discovery (Service Host Interconnect Protocol, Service Lookup Availability Protocol)

## Dependencies

**Runtime:**
- `@bsv/gasp` — Graph Aware Sync Protocol for inter-service synchronization
- `@bsv/sdk` — BSV SDK for Transaction, ChainTracker, Broadcaster, MerklePath, LookupQuestion/Answer types
- `knex` — SQL query builder (for KnexStorage)

**Dev:**
- jest, ts-jest, typescript, ts-standard

## Common pitfalls / gotchas

1. **Topic vs Service naming**: Topic managers are prefixed `tm_*`, lookup services `ls_*` by default in discovery
2. **BEEF encoding required**: All transactions must be submitted in BEEF format; raw hex will fail
3. **Previous coins array**: When resubmitting transactions spending prior outputs, must include indices of those inputs in `previousCoins`
4. **Knex migrations**: Custom storage implementations must handle schema creation; KnexStorage provides standard migrations
5. **GASP sync context**: SHIP/SLAP topics (tm_ship, tm_slap) have special handling for peer discovery configuration
6. **Metadata vs storage**: LookupService receives either locking-script OR whole-tx based on admissionMode; must implement accordingly
7. **Chain validation**: If chainTracker is 'scripts only', SPV proofs are not validated; useful for testing but unsafe for production

## Spec conformance

- Implements BSV Overlay protocol for UTXO tracking
- Supports SHIP (Service Host Interconnect Protocol) and SLAP (Service Lookup Availability Protocol) for peer discovery
- Integrates Graph Aware Sync Protocol (GASP) for historical synchronization with other overlay nodes

## File map

```
src/
├── Engine.ts                 — Main orchestrator class
├── TopicManager.ts           — Topic manager interface
├── LookupService.ts          — Lookup service interface (admissionMode, spendNotificationMode)
├── LookupFormula.ts          — Query result type
├── Output.ts                 — Output record type
├── Advertisement.ts          — Advertisement structure for peer discovery
├── Advertiser.ts             — Advertiser interface
├── SyncConfiguration.ts       — GASP sync config
├── GASP/
│   ├── OverlayGASPRemote.ts  — GASP remote implementation for Engine
│   └── OverlayGASPStorage.ts — GASP storage implementation for Engine
└── storage/
    ├── Storage.ts            — Storage interface
    └── knex/
        ├── KnexStorage.ts    — Knex-based SQL storage
        └── migrations/       — Knex migrations (2024-2025)
```

## Integration points

- **@bsv/overlay-express**: Wraps Engine in Express HTTP server with /submit, /lookup, /listTopicManagers, /listLookupServiceProviders endpoints
- **@bsv/overlay-topics**: Provides pre-built topic managers and lookup services (hello, did, kvstore, btms, etc.)
- **@bsv/overlay-discovery-services**: Implements SHIP/SLAP for peer discovery; WalletAdvertiser for certificate-based advertisements
- **@bsv/gasp**: Graph Aware Sync Protocol; OverlayGASPStorage and OverlayGASPRemote adapt Engine to GASP interfaces
- **Custom implementations**: Any TopicManager/LookupService can be registered in Engine; storage can be replaced with custom backends
