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

Requires Node.js 22 or newer. Install `@bsv/sdk` alongside this package to
satisfy its peer dependency. The overlay engine, wallet toolbox client, and
MongoDB driver are direct runtime dependencies.

## Quick start (advertiser)

```ts
import { WalletAdvertiser } from '@bsv/overlay-discovery-services'

const advertiser = new WalletAdvertiser(
  'main', // chain
  privateKeyHex, // signing key
  'https://my-storage.example.com', // wallet storage URL
  'https://my-overlay.example.com' // advertisable URI clients should connect to
)
await advertiser.init()

// Advertise that we host the tm_did topic and ls_did lookup service.
await advertiser.createAdvertisements([
  { protocol: 'SHIP', topicOrServiceName: 'tm_did' },
  { protocol: 'SLAP', topicOrServiceName: 'ls_did' }
])

// Discover everyone else hosting tm_did.
const peers = await advertiser.findAllAdvertisements('SHIP')
```

## Quick start (overlay operator)

Mount the SHIP/SLAP topic managers and lookup services on your overlay node so peers can publish and discover advertisements through your endpoint:

```ts
import {
  SHIPLookupService,
  SHIPStorage,
  SHIPTopicManager,
  SLAPLookupService,
  SLAPStorage,
  SLAPTopicManager
} from '@bsv/overlay-discovery-services'

const topicManagers = {
  tm_ship: new SHIPTopicManager(),
  tm_slap: new SLAPTopicManager()
}

const lookupServices = {
  ls_ship: new SHIPLookupService(new SHIPStorage(db)),
  ls_slap: new SLAPLookupService(new SLAPStorage(db))
}
```

Pass these maps to `Engine`, or register the same instances with your chosen
Overlay Services wrapper.

## Use cases

### Run a discoverable overlay service

Host a topic (e.g. `tm_did`) and publish a SHIP advertisement so other nodes route relevant transactions to you.

### Find peers for a given topic

```ts
const hosts = await advertiser.findAllAdvertisements('SHIP')
const didHosts = hosts.filter(a => a.topicOrService === 'tm_did')
```

### Take a service offline

```ts
const mine = await advertiser.findAllAdvertisements('SLAP')
await advertiser.revokeAdvertisements(mine.filter(a => a.topicOrService === 'ls_did'))
```

## API

| Export                                            | Purpose                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `SHIPTopicManager`                                | Admits well-formed SHIP advertisement outputs to the `tm_ship` topic |
| `SLAPTopicManager`                                | Admits well-formed SLAP advertisement outputs to the `tm_slap` topic |
| `SHIPLookupService` / `SLAPLookupService`         | Index and answer discovery queries                                   |
| `SHIPStorage` / `SLAPStorage`                     | MongoDB-backed discovery records                                     |
| `WalletAdvertiser`                                | High-level advertise/find/revoke API backed by a wallet              |
| `isAdvertisableURI` / `isValidTopicOrServiceName` | Validation helpers                                                   |

## Runtime and security

The package publishes matching ESM and CommonJS entry points with
condition-specific TypeScript declarations. Advertisement names, signatures,
and URIs are validated before admission.

Discovery advertisements contain public connection endpoints. Treat discovered
hosts as untrusted network input: retain TLS validation, apply request timeouts,
do not forward credentials to discovered origins, and validate responses. The
HTTP service that hosts SHIP and SLAP normally remains reachable from arbitrary
browser and mobile origins; use an exact-origin CORS allowlist only when a
deployment has a genuinely closed caller set. CORS does not replace protocol or
administrative authentication.

## Development

From the repository root:

```bash
pnpm --filter @bsv/overlay-discovery-services format:check
pnpm --filter @bsv/overlay-discovery-services lint
pnpm --filter @bsv/overlay-discovery-services typecheck
pnpm --filter @bsv/overlay-discovery-services test
pnpm --filter @bsv/overlay-discovery-services test:coverage
pnpm --filter @bsv/overlay-discovery-services pack:check
```

The package check verifies the published tarball, declarations, and clean ESM
and CommonJS consumers.

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
