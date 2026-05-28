# @bsv/overlay-topics

[![npm version](https://img.shields.io/npm/v/@bsv/overlay-topics)](https://www.npmjs.com/package/@bsv/overlay-topics)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/overlay-topics)](https://www.npmjs.com/package/@bsv/overlay-topics)

Canonical topic managers and lookup services for the BSV overlay network. Bundles the reference implementations that overlay nodes mount to host first-class on-chain protocols — identity certificates, key/value storage, DIDs, message boxes, app catalogs, and more — without having to write a `TopicManager` / `LookupService` for each one from scratch.

## Install

```bash
npm install @bsv/overlay-topics
```

Peer dependencies: `@bsv/sdk`, `@bsv/overlay`.

## Quick start

Register a managed topic on an overlay engine:

```ts
import {
  IdentityTopicManager,
  createIdentityLookupService,
} from '@bsv/overlay-topics'

engine.registerTopicManager('tm_identity', new IdentityTopicManager())
engine.registerLookupService('ls_identity', createIdentityLookupService(db))
```

Each topic ships a matching `*TopicManager` (admission rules for incoming transactions) and `create*LookupService(db)` factory (query surface for clients).

## Included topics

| Topic | Manager | Lookup |
|-------|---------|--------|
| `tm_any` / `ls_any` | `AnyTopicManager` | `createAnyLookupService` |
| `tm_apps` / `ls_apps` | `AppsTopicManager` | `createAppsLookupService` |
| `tm_basketmap` / `ls_basketmap` | `BasketMapTopicManager` | `createBasketMapLookupService` |
| `tm_btms` / `ls_btms` | `BTMSTopicManager` | `createBTMSLookupService` |
| `tm_certmap` / `ls_certmap` | `CertMapTopicManager` | `createCertMapLookupService` |
| `tm_desktopintegrity` / `ls_desktopintegrity` | `DesktopIntegrityTopicManager` | `createDesktopIntegrityLookupService` |
| `tm_did` / `ls_did` | `DIDTopicManager` | `createDIDLookupService` |
| `tm_fractionalize` / `ls_fractionalize` | `FractionalizeTopicManager` | `createFractionalizeLookupService` |
| `tm_hello` / `ls_hello` | `HelloWorldTopicManager` | `createHelloWorldLookupService` |
| `tm_identity` / `ls_identity` | `IdentityTopicManager` | `createIdentityLookupService` |
| `tm_kvstore` / `ls_kvstore` | `KVStoreTopicManager` | `createKVStoreLookupService` |
| `tm_messagebox` / `ls_messagebox` | `MessageBoxTopicManager` | `createMessageBoxLookupService` |
| `tm_monsterbattle` / `ls_monsterbattle` | `MonsterBattleTopicManager` | `createMonsterBattleLookupService` |
| `tm_protomap` / `ls_protomap` | `ProtoMapTopicManager` | `createProtoMapLookupService` |
| `tm_slackthreads` / `ls_slackthreads` | `SlackThreadsTopicManager` | `createSlackThreadsLookupService` |
| `tm_supplychain` / `ls_supplychain` | `SupplyChainTopicManager` | `createSupplyChainLookupService` |
| `tm_uhrp` / `ls_uhrp` | `UHRPTopicManager` | `createUHRPLookupService` |
| `tm_ump` / `ls_ump` | `UMPTopicManager` | `createUMPLookupService` |
| `tm_utility` / `ls_utility` | `UtilityTokenTopicManager` | `createUtilityTokenLookupService` |
| `tm_walletconfig` / `ls_walletconfig` | `WalletConfigTopicManager` | `createWalletConfigLookupService` |

Per-topic query types (`*Query`, `*Record`) are exported alongside.

## Use cases

### Stand up a full-stack overlay node

Mount every canonical topic at once so your node accepts and serves the standard BSV overlay protocols:

```ts
import * as topics from '@bsv/overlay-topics'

for (const [name, mgr, svc] of [
  ['identity',  new topics.IdentityTopicManager(),  topics.createIdentityLookupService(db)],
  ['kvstore',   new topics.KVStoreTopicManager(),   topics.createKVStoreLookupService(db)],
  ['certmap',   new topics.CertMapTopicManager(),   topics.createCertMapLookupService(db)],
  ['did',       new topics.DIDTopicManager(),       topics.createDIDLookupService(db)],
  // ...
] as const) {
  engine.registerTopicManager(`tm_${name}`, mgr)
  engine.registerLookupService(`ls_${name}`, svc)
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
  query: { protectedKey: '...' } satisfies KVStoreQuery,
})
```

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
