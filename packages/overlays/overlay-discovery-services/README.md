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
  privateKeyHex, // dedicated root signing key; keep secret
  'https://my-storage.example.com', // wallet storage URL
  'https://my-overlay.example.com' // advertisable URI clients should connect to
)
await advertiser.init()

// Advertise that we host the tm_did topic and ls_did lookup service.
await advertiser.createAdvertisements([
  { protocol: 'SHIP', topicOrServiceName: 'tm_did' },
  { protocol: 'SLAP', topicOrServiceName: 'ls_did' }
])

// Recover this identity's current advertisements for reconciliation/revocation.
const mine = await advertiser.findAllAdvertisements('SHIP')
```

For TerraTestNet, pass `ttn` as the chain and a TTN wallet-storage URL. Unless
overridden with `lookupResolverConfig`, the advertiser uses the isolated
`teratestnet` resolver preset and TTN Arcade-backed wallet services.

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
const hosts = await engine.lookup({
  service: 'ls_ship',
  query: { topics: ['tm_did'], limit: 100 }
})
```

`WalletAdvertiser.findAllAdvertisements()` intentionally returns only
cryptographically authenticated advertisements owned by that advertiser's
identity. Use the SHIP/SLAP lookup services to discover other identities.

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
URIs, canonical PushDrop envelopes, and identity-to-locking-key linkage are
validated before admission. Lookup query objects must contain only documented
plain-data fields. Results default to at most 1,000 records; `limit` accepts
integers from 0 through 1,000, `skip` is bounded, and `limit: 0` returns an
empty page. Paginate deliberately rather than relying on an unbounded
`findAll` response.

`WalletAdvertiser` retains its constructor `privateKey` as a public instance
property solely for backward compatibility. That value is the root wallet
secret. Use a dedicated key, keep the instance inside one trusted process, and
never log, serialize, return, inspect, or pass it to plugins or untrusted code.
The create and revoke paths bind requested inputs/outputs and the wallet's final
signed transaction; revoke additionally authenticates each one-satoshi token,
its owner, metadata, and exact outpoint before asking the wallet to sign.

`parseAdvertisement()` validates canonical structure only because the public
interface is synchronous. It does not establish signature authenticity. Prefer
the topic-manager admission decision or `WalletAdvertiser`'s verified find and
revoke methods for security decisions.

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

Current TS Stack changes are licensed under the Open BSV License Version 6; see
[LICENSE.txt](./LICENSE.txt). This package also retains pre-uniformization code
under the Open BSV License Version 4. Redistributors must preserve
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and the applicable text in
[`LICENSES/`](./LICENSES/).

## Next dependency release candidate

This candidate refreshes the packed first-party dependency ranges for the next
wallet interoperability release. It adds no independent API or wire-format
change. Adopt after the new dependency graph is published; current wallet
releases retain their existing published pins.
