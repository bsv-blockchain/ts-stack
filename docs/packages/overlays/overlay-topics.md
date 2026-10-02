---
id: overlay-topics
title: '@bsv/overlay-topics'
kind: package
domain: overlays
npm: '@bsv/overlay-topics'
version: '2.0.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
review_cadence_days: 30
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/topics'
status: experimental
tags: ['overlay', 'topics', 'uhrp']
---

# @bsv/overlay-topics

This source candidate declares SDK peer `^2.1.6 || ^3.0.0`. SDK3 remains
a coordinated proposal; see the [qualification and migration limits](../../guides/identity-did-vc-migration.md)
before adopting it.

> Canonical collection of pre-built BSV overlay topic managers and lookup services for identity, tokens, supply chain, messaging, and more.

## DID overlay retirement (2.0 candidate)

The proposed 2.0 release removes the serial-token DID overlay and its exports.
Use the existing identity overlay for attributed public certificate discovery
and `@bsv/did` for identity-key encoding/resolution. No service is automatically
installed, and source removal deletes no historical records or on-chain outputs.
Historical serial lookups cannot establish subject or issuer identity without
separately authenticated bindings. See [integration guidance](../../guides/identity-did-vc.md)
and [migration guidance](../../guides/identity-did-vc-migration.md).

## Registry topics and publisher authority

ProtoMap, BasketMap and CertMap index optional signed descriptions of protocol
identifiers, baskets and certificate types. An overlay host serves records; the
signing publisher supplies their attribution. Hosting the service does not grant
the publisher's key or control which protocols applications can use. See
[registry metadata](../../guides/registry-metadata.md) for lookup identities,
BRC-based inclusion requests, replication and wallet fallback expectations.
These descriptive registries do not install executable permission modules.

## Install

```bash
npm install @bsv/overlay-topics
```

## Quick start

```typescript
import { HelloWorldTopicManager, createHelloWorldLookupService } from '@bsv/overlay-topics'
import { BTMSTopicManager, createBTMSLookupService } from '@bsv/overlay-topics'

const helloManager = new HelloWorldTopicManager()
const helloService = await createHelloWorldLookupService(mongoDb)

const btmsManager = new BTMSTopicManager()
const btmsService = await createBTMSLookupService(mongoDb)

const results = await btmsService.lookup({
  service: 'ls_btms',
  query: { assetId: 'txid.0' }
})
```

## What it provides

- **20+ topic managers** — Pre-built implementations (HelloWorld, identity certificates, BTMS, KVStore, SupplyChain, UHRP, UMP, ProtoMap, and more)
- **Lookup service factories** — Each topic includes MongoDB-backed lookup service
- **Type-safe queries** — Each topic defines its own Query and Record types
- **PushDrop encoding** — All topics use standardized data encoding for consistency
- **Auto-indexing** — Lookup services auto-create MongoDB indices for efficient queries
- **Complete documentation** — Each topic includes metadata and protocol docs

For UMP, `UMPTopicManager` and `createUMPLookupService` can share a
`MongoUMPIdentityStore`. Presentation and recovery hashes are reserved by the
first unspent outpoint and can move only through a transaction that consumes
the current owner. The lookup intentionally returns every matching current
UTXO so a wallet can resolve lineage or use a verified WAB pin for pre-existing
ambiguous state.

## Common patterns

### Register multiple topics in OverlayExpress

```typescript
import OverlayExpress from '@bsv/overlay-express'
import {
  HelloWorldTopicManager,
  createHelloWorldLookupService,
  IdentityTopicManager,
  createIdentityLookupService,
  KVStoreTopicManager,
  createKVStoreLookupService,
  BTMSTopicManager,
  createBTMSLookupService
} from '@bsv/overlay-topics'

const server = new OverlayExpress('mynode', privateKey, 'example.com')

server.configureTopicManager('tm_helloworld', new HelloWorldTopicManager())
server.configureTopicManager('tm_identity', new IdentityTopicManager())
server.configureTopicManager('tm_kvstore', new KVStoreTopicManager())
server.configureTopicManager('tm_btms', new BTMSTopicManager())

await server.configureLookupServiceWithMongo('ls_helloworld', db =>
  createHelloWorldLookupService(db)
)
await server.configureLookupServiceWithMongo('ls_identity', db => createIdentityLookupService(db))
await server.configureLookupServiceWithMongo('ls_kvstore', db => createKVStoreLookupService(db))
await server.configureLookupServiceWithMongo('ls_btms', db => createBTMSLookupService(db))

await server.configureEngine()
await server.start()
```

### Query by topic

```typescript
import { createIdentityLookupService } from '@bsv/overlay-topics'
import type { IdentityQuery } from '@bsv/overlay-topics'

// Inputs are compressed identity keys; certifiers come from the application's trust policy.
const identityService = createIdentityLookupService(mongoDb)
const identityResults = await identityService.lookup({
  service: 'ls_identity',
  query: {
    identityKey: subjectIdentityKey,
    certifiers: trustedCertifierKeys,
    limit: 10,
    offset: 0
  } satisfies IdentityQuery
})

// KVStore query
const kvResults = await kvService.lookup({
  service: 'ls_kvstore',
  query: {
    key: 'mykey',
    controller: '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
  }
})

// Supply chain query
const scResults = await scService.lookup({
  service: 'ls_supplychain',
  query: { chainId: 'abc123' }
})
```

### Manual topic manager use

```typescript
const manager = new IdentityTopicManager()
const admittance = await manager.identifyAdmissibleOutputs(beef, [])
// Validates the attributed public identity certificate and revelation envelope.
```

## Key concepts

- **Topic managers** — Validate which outputs are protocol-valid (implements TopicManager interface)
- **Lookup services** — Index and query admitted outputs in MongoDB (implements LookupService interface)
- **PushDrop encoding** — All topics use PushDrop format for structured data + signature/lock
- **Protocol-specific fields** — Each topic defines what fields it expects (e.g., identity admission validates the certificate and public revelation)
- **Query types** — Each topic defines type-safe Query and Record types
- **Lookup factories** — `create*LookupService(db)` factories return configured services
- **MongoDB indexing** — Services auto-create indices on frequently-queried fields; a failed build is
  logged and skipped so reads keep working, and retried on the next call
- **`OVERLAY_INDEX_REPAIR`** — Opt-in. When a _unique_ index cannot be built because the collection
  already holds duplicate rows, setting this to `true` deletes the duplicates (oldest row per key is
  kept) and rebuilds the index. It deletes rows, so it is off by default

## When to use this

- Running an overlay node with multiple topics
- Need pre-built, tested topic implementations
- Want standardized PushDrop encoding
- Building applications on top of overlay services
- Need token management (BTMS), public identity certificate discovery, or key-value storage

## When NOT to use this

- For custom protocol topics — implement TopicManager/LookupService directly
- If you don't need lookup queries — just use topic managers
- Without MongoDB backend — lookup services require MongoDB

## Spec conformance

- **Identity** — Public discovery of attributed certificates under BRC-189
  semantics. Validate the original certificate signature and selected certifier
  trust separately from discovering an overlay host. Identity-key `did:key`
  resolution under the proposed BRC-202 profile is deterministic and uses no
  lookup service.
- **BTMS** — Basic Token Management System protocol (issuance, transfer, burn)
- **KVStore** — Key-value protocol-agnostic storage
- **ProtoMap** — Registry of wallet protocols with deserialization support
- **UHRP** — Unified Hash Registry Protocol
- **UMP** — Universal Messenger Protocol
- **All topics** — Use PushDrop encoding per @bsv/sdk

## Common pitfalls

1. **Lookup factories** — Construct services with the documented synchronous factory; await their lookup methods
2. **MongoDB required** — All lookup services assume MongoDB; no Knex fallback
3. **PushDrop validation** — Each topic validates structure; malformed scripts are rejected
4. **Protocol validation varies** — Use each topic's admission rules; an identity revelation is not a legacy serial token
5. **BTMS asset semantics** — "ISSUE" = new token; otherwise must match previous issuance txid.outputIndex
6. **Signature validation** — Most topics verify signatures; invalid signatures cause rejection

## Available topics

- **any** — Catch-all topic accepting any PushDrop output
- **btms** — Basic Token Management System (token issuance/transfer)
- **apps** — Application catalog
- **basketmap** — Publisher-attributed descriptions of basket identifiers
- **certmap** — Publisher-attributed certificate-type and field descriptions
- **desktopintegrity** — Desktop integrity verification
- **fractionalize** — Token fractionalization
- **hello** — Hello World demo topic
- **identity** — Identity attributes and claims
- **kvstore** — Key-value store
- **mandala** — Regulated fungible tokens on BRC-162 (`tm_mandala` / `ls_mandala`)
- **mandala-registry** — Mandala issuer identity registry (`tm_mandala_registry` / `ls_mandala_registry`)
- **message-box** — Inbox/messaging
- **monsterbattle** — Game state (demo)
- **protomap** — Publisher-attributed descriptions of wallet protocol tuples
- **slackthreads** — Slack thread indexing
- **supplychain** — Supply chain tracking
- **uhrp** — Unified Hash Registry Protocol
- **ump** — Universal Messenger Protocol
- **utility-tokens** — Fungible token demo
- **walletconfig** — Wallet configuration

## Related packages

- [@bsv/overlay](./overlay.md) — Core Engine and interfaces
- [@bsv/overlay-express](./overlay-express.md) — HTTP server wrapper
- [@bsv/overlay-discovery-services](./overlay-discovery-services.md) — SHIP/SLAP peer discovery
- [@bsv/gasp](./gasp.md) — Graph Aware Sync Protocol

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/overlay-topics/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/topics)
- [npm](https://www.npmjs.com/package/@bsv/overlay-topics)

## UORA v3 reader compatibility

Version 1.7.2 aligns `readUoraAnchor` and `tm_uora_dpp` with the UORA v3 format:
a 33-byte compressed locking key, eight fields, exactly four `OP_2DROP`
instructions, and printable UTF-8 text without C0/C1 controls or DEL. Valid
anchors keep the same bytes, signing preimage, topic identifier and admission
result. Unicode text remains supported; no new normalization is applied.

Coordinate reader upgrades across nodes serving `tm_uora_dpp`. Audit any
previously indexed nonconforming outputs before rebuilding that topic, because
older readers may have admitted inputs that the format does not permit.
Repository fixtures establish format compatibility; they do not establish an
inventory of every deployed or historical anchor. Other topics, lookup query
shapes and persisted schemas are unchanged.

### Mandala on BRC-162

`tm_mandala` / `ls_mandala` admit and index Mandala regulated fungible tokens
written in BRC-162 (BSV-21 binary, authority supply). The 2.0.0 candidate
replaces the earlier `MandalaToken` / `MandalaAdmin` admission and storage API,
and `@bsv/templates` 2.0.0 no longer exports those templates. Each manager and
lookup service serves its full contract through `getDocumentation()`.

**Roles and format.** Every token output is one satoshi to a P2PKH script behind
`<id> <amount> OP_2DROP` and an optional strict DAG-CBOR payload. A deploy (id
and amount `OP_0`, output 0 only) carries `{sym, dec, label, feeRatePerKb?}`; an
authority output (amount `OP_0`) carries nothing or an `{adm}` commitment to one
admin action; a value output has an amount above zero. The token id is
`<deploy txid>_0`. Pushes must be canonical: an output shaped like a token whose
encoding is not canonical is refused, never skipped. Amounts and the circulating
supply stay at or below 2^53-1, and a fixed-supply deploy is refused.

**Envelope v3.** The off-chain values are UTF-8 JSON
`{ inputs, outputs, admin, deploySig }`. `outputs` carries a verified key linkage
for every token output, `inputs` optionally proves the stored owner controls the
coin being spent, and `admin` carries the strict DAG-CBOR details (lowercase hex)
that the authority output's `adm` commits to. `deploySig` is the deploy owner's
signature over `mandala-deploy:<txid>`, so a replayed deploy cannot reuse an
earlier linkage.

**Validation and codes.** Four layers run in order: A (the BRC-162 ledger), B
(ownership), C (issuer authority) and D (pause, freeze, access mode, sanctions and
registry membership). A refusal throws a typed `MandalaReject { code, reason }`.
Codes are `ERR_SHAPE`, `ERR_SATOSHIS`, `ERR_LINKAGE`, `ERR_AUTHORITY`,
`ERR_CONSERVATION`, `ERR_UNTRUSTED`, `ERR_FROZEN`, `ERR_PAUSED`, `ERR_ACCESS`,
`ERR_SANCTIONED`, `ERR_MEMBERSHIP` and `ERR_UNAVAILABLE`. Infrastructure faults
(`ERR_UNAVAILABLE`) and untrusted owners (`ERR_UNTRUSTED`) are retryable and must
never be persisted as a verdict on the transaction.

**Trusted issuers.** `MandalaTopicManager` requires `trustedIssuers`, a non-empty
list of unique, compressed, lowercase identity keys; construction throws
otherwise. Every deploy and authority output must be owned and proven by a
trusted issuer. The set is configuration, never asset state. Sanctions come from a
`ScreeningProvider` that must return exact booleans, and registry membership from
an optional `MembershipProvider`.

**Owner journal and repair.** Before returning admittance, the manager appends
the verified owner of every admitted token output to the append-only
`mandalaOwners` journal; if that write fails nothing is admitted. The
`mandalaTokens` and `mandalaAuthorities` rows written by lookup are an index of
the journal. A spend whose owner row is missing or disagrees with the coin's
script is repaired inline from the journal and the engine's admitted output
(`engineOutputs`), once, and admitted. A row that cannot be repaired answers
`ERR_UNAVAILABLE`, never `ERR_SHAPE` or `ERR_LINKAGE`. `reconcileOwnerIndex`
repairs the same rows for every unspent admitted output of a topic at boot and on
an interval, and reports the ones it cannot repair. `MandalaLookupService`
carries the eviction API (`outputEvicted`, `purgeAndRefold`, `restoreInputRow`);
`mandalaOwners` is never purged.

**Registry.** `tm_mandala_registry` / `ls_mandala_registry` keep the issuer
identity registry as its own authority-only token, admitting only
`admitIdentity` and `revokeIdentity` actions. `registryMembership` exposes its
cache to `tm_mandala` as the membership provider.

**Upgrading.** This is a clean break with no data migration. The persisted schema
changes (`mandalaOwners` and `mandalaAuthorities` are new; `mandalaTokens`,
`mandalaMetadata`, `mandalaAssetStates` and `mandalaAdminHistory` change shape
and key by `tokenId`), so a 2.0.0 Mandala topic starts on a new database with new
deploys. Use one `MandalaStorageManager` for admission and lookup. The package
`CHANGELOG.md` lists the replaced API.
