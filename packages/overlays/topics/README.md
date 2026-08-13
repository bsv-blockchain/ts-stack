# @bsv/overlay-topics

[![npm version](https://img.shields.io/npm/v/@bsv/overlay-topics)](https://www.npmjs.com/package/@bsv/overlay-topics)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/overlay-topics)](https://www.npmjs.com/package/@bsv/overlay-topics)

Canonical topic managers and lookup services for the BSV overlay network. Bundles the reference implementations that overlay nodes mount to host first-class on-chain protocols — identity certificates, key/value storage, DIDs, message boxes, app catalogs, and more — without having to write a `TopicManager` / `LookupService` for each one from scratch.

## Install

```bash
npm install @bsv/overlay-topics
```

Requires Node.js 22 or newer. Install `@bsv/sdk` alongside this package to
satisfy its peer dependency. The overlay engine, templates, and MongoDB driver
are direct runtime dependencies.

## Quick start

Register a managed topic on an overlay engine:

```ts
import { Engine } from '@bsv/overlay'
import { IdentityTopicManager, createIdentityLookupService } from '@bsv/overlay-topics'

const engine = new Engine(
  { tm_identity: new IdentityTopicManager() },
  { ls_identity: createIdentityLookupService(db) },
  storage,
  chainTracker
)
```

Each topic ships a matching `*TopicManager` (admission rules for incoming transactions) and `create*LookupService(db)` factory (query surface for clients).

## Included topics

| Topic                                         | Manager                        | Lookup                                |
| --------------------------------------------- | ------------------------------ | ------------------------------------- |
| `tm_anytx` / `ls_anytx`                       | `AnyTopicManager`              | `createAnyLookupService`              |
| `tm_apps` / `ls_apps`                         | `AppsTopicManager`             | `createAppsLookupService`             |
| `tm_basketmap` / `ls_basketmap`               | `BasketMapTopicManager`        | `createBasketMapLookupService`        |
| `tm_btms` / `ls_btms`                         | `BTMSTopicManager`             | `createBTMSLookupService`             |
| `tm_certmap` / `ls_certmap`                   | `CertMapTopicManager`          | `createCertMapLookupService`          |
| `tm_desktopintegrity` / `ls_desktopintegrity` | `DesktopIntegrityTopicManager` | `createDesktopIntegrityLookupService` |
| `tm_did` / `ls_did`                           | `DIDTopicManager`              | `createDIDLookupService`              |
| `tm_fractionalize` / `ls_fractionalize`       | `FractionalizeTopicManager`    | `createFractionalizeLookupService`    |
| `tm_helloworld` / `ls_helloworld`             | `HelloWorldTopicManager`       | `createHelloWorldLookupService`       |
| `tm_identity` / `ls_identity`                 | `IdentityTopicManager`         | `createIdentityLookupService`         |
| `tm_kvstore` / `ls_kvstore`                   | `KVStoreTopicManager`          | `createKVStoreLookupService`          |
| `tm_messagebox` / `ls_messagebox`             | `MessageBoxTopicManager`       | `createMessageBoxLookupService`       |
| `tm_monsterbattle` / `ls_monsterbattle`       | `MonsterBattleTopicManager`    | `createMonsterBattleLookupService`    |
| `tm_protomap` / `ls_protomap`                 | `ProtoMapTopicManager`         | `createProtoMapLookupService`         |
| `tm_slackthread` / `ls_slackthread`           | `SlackThreadsTopicManager`     | `createSlackThreadsLookupService`     |
| `tm_supplychain` / `ls_supplychain`           | `SupplyChainTopicManager`      | `createSupplyChainLookupService`      |
| `tm_uora_dpp` / `ls_uora_dpp`                 | `UoraDppTopicManager`          | `createUoraDppLookupService`          |
| `tm_uhrp` / `ls_uhrp`                         | `UHRPTopicManager`             | `createUHRPLookupService`             |
| `tm_users` / `ls_users`                       | `UMPTopicManager`              | `createUMPLookupService`              |
| `tm_tokendemo` / `ls_tokendemo`               | `TokenDemoTopicManager`        | `createTokenDemoLookupService`        |
| `tm_walletconfig` / `ls_walletconfig`         | `WalletConfigTopicManager`     | `createWalletConfigLookupService`     |
| `tm_stas` / `ls_stas`                         | `StasTopicManager`             | `createStasLookupService`             |
| `tm_bsv21` / `ls_bsv21`                       | `Bsv21TopicManager`            | `createBsv21LookupService`            |
| `tm_dstas` / `ls_dstas`                       | `DstasTopicManager`            | `createDstasLookupService`            |
| `tm_mandala` / `ls_mandala`                   | `MandalaTopicManager`          | `createMandalaLookupService`          |

Per-topic query types (`*Query`, `*Record`) are exported alongside.

### UMP identity reservations

`UMPTopicManager` reserves each 32-byte presentation hash and recovery hash for
the first admitted unspent outpoint. A later transaction may reuse either hash
only when it consumes the outpoint that currently owns the reservation. This
prevents an unrelated transaction from creating an ambiguous account lookup by
copying another user's hashes.

Production overlays should share one Mongo database between admission and
lookup. The reference overlay-server wiring constructs a
`MongoUMPIdentityStore` and passes it to both services:

```ts
const identityStore = new MongoUMPIdentityStore(db)
const manager = new UMPTopicManager(identityStore)
const lookup = createUMPLookupService(db, identityStore)
```

The additive `ump_identity_reservations` collection serializes first writers
across replicas. Pending reservations expire if lookup indexing never confirms
admission. On upgrade, existing indexed UMP UTXOs seed the collection without
deleting ambiguous rows. `ls_users` returns all matching current UTXOs so
wallets can use verified lineage and, only if lineage remains ambiguous, an
operator-selected WAB pin.

## Use cases

### Stand up a multi-topic overlay node

Build the manager and lookup maps before constructing the engine:

```ts
import {
  CertMapTopicManager,
  DIDTopicManager,
  IdentityTopicManager,
  KVStoreTopicManager,
  createCertMapLookupService,
  createDIDLookupService,
  createIdentityLookupService,
  createKVStoreLookupService
} from '@bsv/overlay-topics'

const managers = {
  tm_identity: new IdentityTopicManager(),
  tm_kvstore: new KVStoreTopicManager(),
  tm_certmap: new CertMapTopicManager(),
  tm_did: new DIDTopicManager()
}

const lookups = {
  ls_identity: createIdentityLookupService(db),
  ls_kvstore: createKVStoreLookupService(db),
  ls_certmap: createCertMapLookupService(db),
  ls_did: createDIDLookupService(db)
}
```

### Run a single focused overlay

Pick just one topic (e.g. only `tm_kvstore`) and register it on your node.

### Build a client against a managed topic

Use the exported query types to call a `LookupResolver`:

```ts
import type { KVStoreQuery } from '@bsv/overlay-topics'
import { LookupResolver } from '@bsv/sdk'

const resolver = new LookupResolver({ networkPreset: 'mainnet' })
const answer = await resolver.query({
  service: 'ls_kvstore',
  query: { protectedKey: '...' } satisfies KVStoreQuery
})
```

## Runtime and security

This is an ESM package with matching declarations. The published tarball
contains compiled output only. Topic managers parse untrusted transaction
scripts and lookup services process untrusted query objects, so applications
must retain request-size limits, timeouts, query validation, and database
resource controls at the service boundary.

Some managers are demonstrations or protocol-specific reference
implementations. Review admission rules, issuer policy, data retention, query
indexes, and test coverage before enabling a topic in production. In
particular, configure explicit issuer policies for token protocols where the
deployment requires restricted issuers.

### Index initialization and `OVERLAY_INDEX_REPAIR`

Storage managers build their indexes lazily on first use. A build failure is
logged and skipped rather than propagated, so a lookup service keeps answering
even when an index is missing, and the build is retried on the next call.

A unique index cannot be built over a collection that already holds rows
violating it, which is permanent until the data is repaired. Set
`OVERLAY_INDEX_REPAIR=true` (or `1`) to have a failed unique build delete the
duplicate rows — oldest row per key is kept, the rest are removed — and rebuild
the index. **This deletes rows**, so it is off by default; run it deliberately,
against a collection you have a backup of, and unset it afterwards.

## Development

From the repository root:

```bash
pnpm --filter @bsv/overlay-topics format:check
pnpm --filter @bsv/overlay-topics lint
pnpm --filter @bsv/overlay-topics typecheck
pnpm --filter @bsv/overlay-topics test
pnpm --filter @bsv/overlay-topics test:coverage
pnpm --filter @bsv/overlay-topics pack:check
```

The package check verifies the npm tarball, strict type resolution, and a clean
ESM consumer.

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
