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
