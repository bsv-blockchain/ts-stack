# @bsv/overlay-discovery-services

[![npm version](https://img.shields.io/npm/v/@bsv/overlay-discovery-services)](https://www.npmjs.com/package/@bsv/overlay-discovery-services)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/overlay-discovery-services)](https://www.npmjs.com/package/@bsv/overlay-discovery-services)

Discovery layer for the BSV overlay network. Implements **SHIP** (Service Host Interconnect Protocol) and **SLAP** (Service Lookup Availability Protocol) — the two protocols that let overlay nodes advertise the topics they host and the lookup services they expose, so peers can find each other without a central registry.

This package ships:

- `SHIPTopicManager` / `SHIPLookupService` — admission and querying for SHIP advertisement tokens
- `SLAPTopicManager` / `SLAPLookupService` — admission and querying for SLAP advertisement tokens
- `WalletAdvertiser` — a turnkey `Advertiser` implementation that creates, finds, and revokes SHIP/SLAP advertisements using a BRC-100 wallet

## Install

```bash
npm install @bsv/overlay-discovery-services
```

Peer dependencies: `@bsv/sdk`, `@bsv/overlay`, `@bsv/wallet-toolbox-client`.

## Quick start (advertiser)

```ts
import { WalletAdvertiser } from '@bsv/overlay-discovery-services'

const advertiser = new WalletAdvertiser(
  'main',                                // chain
  privateKeyHex,                         // signing key
  'https://my-storage.example.com',      // wallet storage URL
  'https://my-overlay.example.com'       // advertisable URI clients should connect to
)
await advertiser.init()

// Advertise that we host the tm_did topic and ls_did lookup service.
await advertiser.createAdvertisements([
  { protocol: 'SHIP', topicOrServiceName: 'tm_did' },
  { protocol: 'SLAP', topicOrServiceName: 'ls_did' },
])

// Discover everyone else hosting tm_did.
const peers = await advertiser.findAllAdvertisements('SHIP')
```

## Quick start (overlay operator)

Mount the SHIP/SLAP topic managers and lookup services on your overlay node so peers can publish and discover advertisements through your endpoint:

```ts
import {
  SHIPTopicManager,
  SLAPTopicManager,
  SHIPLookupServiceFactory,
  SLAPLookupServiceFactory,
} from '@bsv/overlay-discovery-services'

engine.registerTopicManager('tm_ship', new SHIPTopicManager())
engine.registerTopicManager('tm_slap', new SLAPTopicManager())
engine.registerLookupService('ls_ship', SHIPLookupServiceFactory(db))
engine.registerLookupService('ls_slap', SLAPLookupServiceFactory(db))
```

## Use cases

### Run a discoverable overlay service

Host a topic (e.g. `tm_did`) and publish a SHIP advertisement so other nodes route relevant transactions to you.

### Find peers for a given topic

```ts
const hosts = await advertiser.findAllAdvertisements('SHIP')
const didHosts = hosts.filter(a => a.topicOrServiceName === 'tm_did')
```

### Take a service offline

```ts
const mine = await advertiser.findAllAdvertisements('SLAP')
await advertiser.revokeAdvertisements(mine.filter(a => a.topicOrServiceName === 'ls_did'))
```

## API

| Export | Purpose |
|--------|---------|
| `SHIPTopicManager` | Admits well-formed SHIP advertisement outputs to the `tm_ship` topic |
| `SLAPTopicManager` | Admits well-formed SLAP advertisement outputs to the `tm_slap` topic |
| `SHIPLookupServiceFactory` / `SLAPLookupServiceFactory` | Build the matching lookup services |
| `WalletAdvertiser` | High-level advertise/find/revoke API backed by a wallet |
| `isAdvertisableURI` / `isValidTopicOrServiceName` | Validation helpers |

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
