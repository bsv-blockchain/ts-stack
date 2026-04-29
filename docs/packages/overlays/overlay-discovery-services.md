---
id: overlay-discovery
title: "@bsv/overlay-discovery-services"
kind: package
domain: overlays
npm: "@bsv/overlay-discovery-services"
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["overlay", "discovery"]
---

# @bsv/overlay-discovery-services

> Implements SHIP and SLAP protocols for peer discovery and service advertisement in overlay networks.

## Install

```bash
npm install @bsv/overlay-discovery-services
```

## Quick start

```typescript
import { isAdvertisableURI, isValidTopicOrServiceName } from '@bsv/overlay-discovery-services'

// SHIP and SLAP are auto-registered by Engine
const engine = new Engine(
  managers,
  lookupServices,
  storage,
  chainTracker,
  'https://mynode.example.com',
  ['https://ship.example.com'],  // SHIP trackers
  ['https://slap.example.com']   // SLAP trackers
)

// Query SHIP for topic hosts
const shipResults = await engine.lookup({
  service: 'ls_ship',
  query: {
    topicName: 'tm_hello',
    since: Date.now() - 86400000  // Last 24 hours
  }
})

// Query SLAP for lookup services
const slapResults = await engine.lookup({
  service: 'ls_slap',
  query: {
    serviceName: 'ls_hello',
    since: Date.now() - 86400000
  }
})
```

## What it provides

- **SHIPTopicManager & SHIPLookupService** — Service Host Interconnect Protocol for discovering topic hosts
- **SLAPTopicManager & SLAPLookupService** — Service Lookup Availability Protocol for discovering lookup services
- **WalletAdvertiser** — Token-based advertiser for certificate-backed advertisements
- **Validation utilities** — `isAdvertisableURI()`, `isValidTopicOrServiceName()`, `isTokenSignatureCorrectlyLinked()`
- **Storage implementations** — MongoDB-backed storage for SHIP and SLAP records
- **Auto-indexing** — Creates indices on topicName and serviceName for efficient discovery

## Common patterns

### Validate URIs and names

```typescript
import { isAdvertisableURI, isValidTopicOrServiceName } from '@bsv/overlay-discovery-services'

const valid = isAdvertisableURI('https://node.example.com')
const validName = isValidTopicOrServiceName('tm_custom_topic')
```

### Use WalletAdvertiser for publishing

```typescript
const advertiser = new WalletAdvertiser(wallet)

// Publish SHIP advertisement (host supporting a topic)
await advertiser.advertiseHost({
  uri: 'https://mynode.example.com',
  topicName: 'tm_hello',
  hostPublicKey: '03abc...'
})

// Publish SLAP advertisement (service provided)
await advertiser.advertiseService({
  uri: 'https://mynode.example.com',
  serviceName: 'ls_hello',
  servicePublicKey: '03def...'
})
```

### Discover peers via SHIP/SLAP

```typescript
// After Engine is initialized with tracker URLs
const hostDiscovery = await engine.lookup({
  service: 'ls_ship',
  query: {
    topicName: 'tm_btms'
  }
})
// Returns: { hosts: [{ uri, hostPublicKey, ... }, ...] }

const serviceDiscovery = await engine.lookup({
  service: 'ls_slap',
  query: {
    serviceName: 'ls_kvstore'
  }
})
// Returns: { services: [{ uri, servicePublicKey, ... }, ...] }
```

## Key concepts

- **SHIP (Service Host Interconnect Protocol)** — Peer discovery for topic managers; hosts advertise which topics they support
- **SLAP (Service Lookup Availability Protocol)** — Peer discovery for lookup services; nodes advertise which services they provide
- **Advertisement** — A transaction output containing metadata (URI, public key, topic/service name)
- **Token-based signing** — Advertisements can be signed/verified using certificate signatures linked to transactions
- **WalletAdvertiser** — Uses wallet to sign advertisements; verifies signatures are correctly linked to published outputs
- **Topic naming** — Format `tm_*` (e.g., `tm_hello`, `tm_ship`, `tm_btms`)
- **Service naming** — Format `ls_*` (e.g., `ls_hello`, `ls_slap`, `ls_btms`)
- **URI validation** — Must be HTTPS with valid domain (localhost/IPs not advertised in production)

## When to use this

- Running an overlay node that wants to be discoverable by peers
- Need to find overlay hosts or lookup services for a specific topic
- Bootstrapping a peer discovery network
- Publishing service advertisements
- Building federated overlay networks

## When NOT to use this

- For direct peer connections — use point-to-point networking
- For non-overlay services — only works with overlay protocol
- If you don't need peer discovery — overlay services work standalone

## Spec conformance

- **SHIP protocol** — Service Host Interconnect Protocol (BSV overlay spec)
- **SLAP protocol** — Service Lookup Availability Protocol (BSV overlay spec)
- **Certificate linking** — Token signatures linked to outputs (per BSV wallet authentication standards)
- **PushDrop encoding** — Advertisement data stored in PushDrop format

## Common pitfalls

1. **Auto-registration** — SHIP/SLAP are auto-registered by Engine; don't manually add `tm_ship` and `tm_slap`
2. **Topic/service naming** — Must follow `tm_*` or `ls_*` pattern; invalid names rejected by validators
3. **URI format** — Must be valid HTTPS; localhost/IPs not advertised in production
4. **Token signature linkage** — Advertiser verifies signature is linked to the transaction; mismatched signatures fail
5. **Storage isolation** — SHIP and SLAP have separate storage; wrong service query returns no results
6. **Bootstrap requirement** — Engine needs at least one SHIP/SLAP tracker URL to bootstrap peer discovery

## Related packages

- [@bsv/overlay](./overlay.md) — Core Engine that integrates SHIP/SLAP
- [@bsv/overlay-express](./overlay-express.md) — HTTP server with automatic SHIP/SLAP configuration
- [@bsv/gasp](./gasp.md) — Can sync with discovered peers
- [@bsv/overlay-topics](./overlay-topics.md) — Topic managers that can be advertised via SHIP/SLAP

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/overlay-discovery-services/)
- [Source on GitHub](https://github.com/bsv-blockchain/overlay-discovery-services)
- [npm](https://www.npmjs.com/package/@bsv/overlay-discovery-services)
