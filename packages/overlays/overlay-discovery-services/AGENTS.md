# CLAUDE.md — @bsv/overlay-discovery-services

## Purpose

Implements Service Host Interconnect Protocol (SHIP) and Service Lookup Availability Protocol (SLAP) for overlay service peer discovery. Also provides token-based advertiser implementations for certificate-based advertisements and wallet integration.

## Public API surface

From `mod.ts`:

**SHIP (Service Host Interconnect Protocol):**
- `SHIPTopicManager` — Topic manager for SHIP advertisements
- `SHIPLookupService` — Lookup service for querying SHIP records
- `SHIPStorage` — Storage implementation for SHIP data

**SLAP (Service Lookup Availability Protocol):**
- `SLAPTopicManager` — Topic manager for SLAP advertisements
- `SLAPLookupService` — Lookup service for querying SLAP records
- `SLAPStorage` — Storage implementation for SLAP data

**Advertiser:**
- `WalletAdvertiser` — Token-based advertiser using certificates

**Utilities:**
- `isAdvertisableURI(uri)` — Validates advertiser/host URIs
- `isValidTopicOrServiceName(name)` — Validates topic/service names (alphanumeric, hyphens, underscores)
- `isTokenSignatureCorrectlyLinked(...)` — Verifies token signature linkage

**Types:**
- All exported from `src/types.ts` — SHIP/SLAP record structures, token types, signatures

## Real usage patterns

From test files and integration with Engine:

```typescript
// 1. SHIP / SLAP are auto-registered by Engine
// When you create an Engine with shipTrackers and slapTrackers:
const engine = new Engine(
  managers,
  lookupServices,
  storage,
  chainTracker,
  hostingURL,
  ['https://ship.example.com'],  // SHIP trackers
  ['https://slap.example.com'],  // SLAP trackers
  broadcaster,
  advertiser  // WalletAdvertiser instance
)

// 2. Query SHIP to discover overlay hosts
const shipResults = await engine.lookup({
  service: 'ls_ship',
  query: {
    topicName: 'tm_hello',
    since: Date.now() - 86400000  // Last 24 hours
  }
})

// 3. Query SLAP to discover lookup services
const slapResults = await engine.lookup({
  service: 'ls_slap',
  query: {
    serviceName: 'ls_hello',
    since: Date.now() - 86400000
  }
})

// 4. Publish SHIP advertisement (via advertiser)
// The Engine handles this internally, but conceptually:
const advertiser = new WalletAdvertiser(wallet)
await advertiser.advertiseHost({
  uri: 'https://mynode.example.com',
  topicName: 'tm_hello',
  hostPublicKey: '03abc...'
})

// 5. Publish SLAP advertisement
await advertiser.advertiseService({
  uri: 'https://mynode.example.com',
  serviceName: 'ls_hello',
  servicePublicKey: '03def...'
})

// 6. Validate URIs and names
import { isAdvertisableURI, isValidTopicOrServiceName } from '@bsv/overlay-discovery-services'

const valid = isAdvertisableURI('https://node.example.com')
const validName = isValidTopicOrServiceName('tm_custom_topic')
```

## Key concepts

- **SHIP (Service Host Interconnect Protocol)**: Peer discovery for topic managers. Hosts advertise which topics they support.
- **SLAP (Service Lookup Availability Protocol)**: Peer discovery for lookup services. Nodes advertise which lookup services they provide.
- **Advertisement**: A transaction output containing metadata about a host/service (URI, public key, topic/service name)
- **Token-based**: Advertisements can be signed/verified using token signatures (certificates linked to transactions)
- **WalletAdvertiser**: Uses wallet to sign advertisements; verifies signatures are correctly linked to published outputs
- **Topic name format**: `tm_*` (e.g., `tm_hello`, `tm_ship`, `tm_btms`)
- **Service name format**: `ls_*` (e.g., `ls_hello`, `ls_slap`, `ls_btms`)
- **URI validation**: Must be HTTPS, valid domain, etc.
- **Signature verification**: Token signatures are verified against the transaction that created the advertisement

## Dependencies

**Runtime:**
- `@bsv/overlay` — TopicManager, LookupService interfaces
- `@bsv/sdk` — Transaction, PrivateKey, PublicKey, Signature, Utils
- `mongodb` — MongoDB for lookup service storage (optional, but expected for production)

**Dev:**
- jest, ts-jest, typescript, ts-standard

## Common pitfalls / gotchas

1. **SHIP/SLAP auto-registration**: Don't manually add `tm_ship` and `tm_slap` unless you're building a custom engine; OverlayExpress handles this
2. **Topic/service naming**: Must follow pattern `tm_*` or `ls_*`; invalid names are rejected by validators
3. **URI format**: Must be valid HTTPS; localhost/IP addresses not advertised in production
4. **Token signature linkage**: WalletAdvertiser verifies that signature is linked to the transaction creating the advertisement; mismatched signatures fail
5. **Advertisement TTL**: SHIP/SLAP records have implicit expiration (tracked by `since` timestamp); stale records may be ignored
6. **Storage isolation**: SHIP and SLAP have separate storage; querying wrong service returns no results
7. **MongoDB indices**: SHIP/SLAP create indices on topicName/serviceName for efficient discovery; creation is automatic
8. **Peer bootstrapping**: Engine needs at least one SHIP/SLAP tracker URL to bootstrap peer discovery

## Spec conformance

- **SHIP protocol**: Service Host Interconnect Protocol (BSV overlay spec)
- **SLAP protocol**: Service Lookup Availability Protocol (BSV overlay spec)
- **Certificate linking**: Token signatures linked to outputs (per BSV wallet authentication standards)
- **PushDrop encoding**: Advertisement data stored in PushDrop format

## File map

```
src/
├── SHIP/
│   ├── SHIPTopicManager.ts      — Validates SHIP advertisement structure
│   ├── SHIPLookupService.ts     — Queries SHIP records
│   ├── SHIPStorage.ts           — MongoDB storage for SHIP
│   ├── SHIPTopic.docs.ts        — Protocol documentation
│   └── SHIPLookup.docs.ts       — Lookup documentation
├── SLAP/
│   ├── SLAPTopicManager.ts      — Validates SLAP advertisement structure
│   ├── SLAPLookupService.ts     — Queries SLAP records
│   ├── SLAPStorage.ts           — MongoDB storage for SLAP
│   ├── SLAPTopic.docs.ts        — Protocol documentation
│   └── SLAPLookup.docs.ts       — Lookup documentation
├── WalletAdvertiser.ts           — Token-based advertiser implementation
├── types.ts                      — Shared types (SHIP/SLAP records, tokens, signatures)
├── utils/
│   ├── isAdvertisableURI.ts      — URI validation
│   ├── isValidTopicOrServiceName.ts — Name validation
│   └── isTokenSignatureCorrectlyLinked.ts — Signature verification
└── __tests__/
    └── [Test files for utilities and advertiser]
```

## Integration points

- **@bsv/overlay Engine**: Auto-registers SHIP/SLAP topic managers and lookup services; uses Advertiser to broadcast
- **@bsv/overlay-express**: Provides `advertisableFQDN` and manages Advertiser instance for Engine
- **@bsv/gasp**: SHIP/SLAP can be sync partners; historical sync enabled via GASP for discovered peers
- **Custom advertisers**: Can implement alternative advertiser interfaces for different trust models
- **External SHIP/SLAP trackers**: Engine connects to bootstrap trackers; discovers peers dynamically
