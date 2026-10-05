# @bsv/overlay-topics

[![npm version](https://img.shields.io/npm/v/@bsv/overlay-topics)](https://www.npmjs.com/package/@bsv/overlay-topics)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/overlay-topics)](https://www.npmjs.com/package/@bsv/overlay-topics)

Canonical topic managers and lookup services for the BSV overlay network. Bundles the reference implementations that overlay nodes mount to host first-class on-chain protocols — identity certificates, key/value storage, message boxes, app catalogs, and more — without having to write a `TopicManager` / `LookupService` for each one from scratch.

UHRP lookup accepts `limit` from 1 through 200 (default 50) and orders pages by transaction ID and output index. This supports the SDK StorageDownloader 200-row query without changing signature or selector validation.

## DID overlay retirement (2.0 candidate)

The proposed 2.0 release removes `DIDTopicManager`, `createDIDLookupService`,
`DIDRecord` and `DIDQuery`, and retires `tm_did` / `ls_did`. The old serial token
omitted issuer and subject; a historical lookup cannot be converted into an
identity assertion by guessing those bindings. Existing stored records and
on-chain outputs are not deleted or spent by this source change.

Use the existing `tm_identity` / `ls_identity` pair for public, attributed
certificate discovery under BRC-189 semantics. Use `@bsv/did` for deterministic
identity-key `did:key` resolution and signature-preserving BRC-52 credential
adapters under the proposed BRC-202/203 profiles. Discovery supplies candidates;
validate certificate signatures and apply the application's selected certifier
trust policy before relying on claims. The host is not the certificate issuer,
and a resolved DID does not prove current key control.

Operators must explicitly choose the services they host and reconcile stale
advertisements separately; this change installs no replacement service. See
[identity integration](../../../docs/guides/identity-did-vc.md) and
[migration guidance](../../../docs/guides/identity-did-vc-migration.md).

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
| `tm_mandala_registry` / `ls_mandala_registry` | `RegistryTopicManager`         | `createRegistryLookupService`         |

Per-topic query types (`*Query`, `*Record`) are exported alongside.

### Mandala on BRC-162

`tm_mandala` / `ls_mandala` admit and index Mandala regulated fungible tokens
written in BRC-162 (BSV-21 binary, authority supply). Admission runs four layers
in order: A (generic BRC-162 ledger, `classifyOutputs` / `buildLedger`), B
(ownership), C (issuer authority) and D (issuer controls). A refusal throws a
typed `MandalaReject { code, reason }`; any other error propagates for the
engine to log. `getDocumentation()` on each manager and lookup service carries
the full contract.

**Roles.** Every token output is one satoshi to a P2PKH script behind
`<id> <amount> OP_2DROP` and an optional strict DAG-CBOR payload (`OP_DROP`).

| Role      | id       | amount | Where         | Payload                                         |
| --------- | -------- | ------ | ------------- | ----------------------------------------------- |
| Deploy    | `OP_0`   | `OP_0` | output 0 only | `{sym, dec, label, feeRatePerKb?}`              |
| Authority | token id | `OP_0` | any           | none, or `{adm}` committing to one admin action |
| Value     | token id | `> 0`  | any           | ignored                                         |

The token id is `<deploy txid>_0`. Pushes are canonical (amount 0 is `OP_0`,
1 to 16 are `OP_1` to `OP_16`, otherwise a minimal little-endian script number),
and an output that is shaped like a token but not canonical is refused, never
skipped. Amounts, value sums and the circulating supply stay at or below
2^53-1. A deploy with an amount (fixed supply) is refused. Payloads are read
only through the strict DAG-CBOR subset of `@bsv/templates`.

**Envelope v3.** The off-chain values are UTF-8 JSON:
`{ inputs, outputs, admin, deploySig }`.

- `outputs` holds a linkage for every token output of every role. It must derive
  the output's public key hash and name its owner.
- `inputs` holds optional linkages that must prove the stored owner controls the
  coin being spent.
- `admin` holds the strict DAG-CBOR details (lowercase hex) of the one committed
  authority output per token; their SHA-256 must equal the payload's `adm`.
- `deploySig` is described below.

**Reject codes.**

| Code                                                                         | When                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_SHAPE`                                                                  | malformed envelope or output, deploy not at output 0, a cap, bad deploy payload, missing admin details                          |
| `ERR_SATOSHIS`                                                               | a token output that does not carry exactly one satoshi                                                                          |
| `ERR_LINKAGE`                                                                | an output without a verified linkage, or an input linkage that does not control the coin                                        |
| `ERR_AUTHORITY`                                                              | fixed-supply or unsigned deploy, authority without continuity, two commitments, commitment mismatch                             |
| `ERR_CONSERVATION`                                                           | value in != value out without an authority, or a supply delta that breaks its rule                                              |
| `ERR_UNTRUSTED`                                                              | a deploy or authority owner, or its prover, or a spent authority's owner, outside `trustedIssuers` (retryable, never persisted) |
| `ERR_FROZEN`, `ERR_PAUSED`, `ERR_ACCESS`, `ERR_SANCTIONED`, `ERR_MEMBERSHIP` | issuer controls, screening and registry membership                                                                              |
| `ERR_UNAVAILABLE`                                                            | a store, journal, engine or provider fault, or an owner index that cannot be repaired (retryable, never persisted)              |

**Trusted issuers.** `MandalaTopicManager` takes `trustedIssuers`: a non-empty
list of unique, compressed, lowercase identity keys. Construction throws
otherwise. Every deploy and authority output must be owned by a trusted issuer
and proven by one, and every authority coin a transaction spends must be owned
by one: removing a key from the set takes away the authority coins it holds (to
rotate a key, move its authority coins to the new key first). Trusted issuers
and `membershipExempt` keys (held to the same key spelling) skip access mode
and registry membership. The set is configuration and never asset state.
Sanctions are answered by a `ScreeningProvider` that must return exact
booleans; registry membership is an optional `MembershipProvider`, enforced as
`ERR_MEMBERSHIP`.

**`deploySig`.** A deploy has no authority input to spend, so the envelope
carries the deploy owner's `createSignature` over the UTF-8 bytes of
`mandala-deploy:<txid>` (protocol `[2, 'mandala deploy']`, key id `'1'`,
counterparty `'anyone'`; see `deployDigest` / `verifyDeploySig`). A replayed
deploy, one built from an earlier linkage, cannot reuse it and is refused
(`ERR_AUTHORITY`).

**Owner journal and repair.** Before returning admittance, the topic manager
appends the verified owner of every admitted token output to the append-only
`mandalaOwners` journal. A failed write answers `ERR_UNAVAILABLE` and nothing is
broadcast; `context.dryRun` (GASP) skips it. The `mandalaTokens` and
`mandalaAuthorities` rows that lookup writes after admission are an index of
that journal, not a source of truth. When the owner row of a spent coin is
missing, or disagrees with the coin's script, the manager repairs it inline
from the journal entry and the engine's admitted output (`engineOutputs`),
credits the balance once, logs the outpoint (`onOwnerRepair`), and admits the
spend. When nothing can repair it the answer is `ERR_UNAVAILABLE`, never
`ERR_SHAPE` or `ERR_LINKAGE`, and a linkage is never a fallback owner source.

**Reconciler.** `reconcileOwnerIndex({ storage, engine, topic })` pages the
engine's unspent admitted outputs of a topic, repairs each missing or
disagreeing row the same way, and returns `{ scanned, repaired, unrepairable }`.
Run it at boot and on an interval, and report `unrepairable` as a degraded
readiness check. Reruns are harmless.

**Boot refold (an overlay duty).** The lookup appends a committed action to
`mandalaAdminHistory` and then folds it into `mandalaAssetStates`; the engine
notifies each output once and only logs a lookup error, so a fault between the
two leaves the action unfolded (a freeze or pause that does not take effect).
At boot, before the engine accepts submissions, call `rebuildState(tokenId)` for
every id in `tokenIdsWithHistory()`; repeat it on the reconciler interval with
submissions quiesced. `rebuildState` reads the history and then writes the
state, so it must never run beside a live fold. Each freeze's fold context (the
frozen coin's amount and owner) is recorded on its history row, so a refold
folds exactly what the live fold did.

**Eviction (an overlay duty).** `MandalaLookupService.outputEvicted` drops an
evicted output's row (debiting its owner). The overlay must also call
`purgeAndRefold(txid)` once for every evicted txid, with submissions quiesced:
it refolds each affected token's admin state without that transaction and then
deletes its history rows (repeating an interrupted run is safe). It may call
`restoreInputRow(journal)` for an input coin of the evicted transaction only
after the engine confirms that coin is unspent and admitted again;
`restoreInputRow` does not check, and would restore a row and a balance for a
coin that is gone. `mandalaOwners` is never purged.

**Storage (clean break).** `MandalaStorageManager` persists `mandalaOwners`
(new, the journal), `mandalaAuthorities` (new), `mandalaTokens`,
`mandalaMetadata`, `mandalaAssetStates`, `mandalaAdminHistory`,
`mandalaLinkageRecords`, `mandalaBalances` and `mandalaCounters`;
`RegistryStorage` adds `mandalaRegistry`. Use one `MandalaStorageManager` for
admission and lookup. Four of these names were 1.x collections with other
shapes: `assetId` is now `tokenId` (a `<txid>_0` string), the asset state loses
`issuerIdentityKey` and gains `feeRatePerKb`, and admin history stores
`detailsHex`, `commitment` and `delta`. 2.0.0 migrates no data and does not read
an old row as a new one, so start Mandala on a new database, with new deploys.

**Registry.** `tm_mandala_registry` / `ls_mandala_registry` carry the issuer's
identity registry as its own authority-only BRC-162 token. Only
`admitIdentity` and `revokeIdentity` actions are allowed, value outputs are
refused, and the first trusted deploy wins. `registryMembership(storage)` turns
the cache into the `MembershipProvider` that `tm_mandala` consumes.

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
across replicas. A failed strict broadcast invokes the manager's provisional
admission abort hook. During a legitimate transfer the confirmed owner remains
authoritative until lookup indexing confirms its successor, so an expired or
interrupted transfer cannot unprotect a live token. Initial pending claims
expire if lookup indexing never confirms admission. On upgrade, existing
indexed UMP UTXOs seed the collection once, with a durable completion marker,
without deleting ambiguous rows. `ls_users` returns the newest 100 matching
current UTXOs so a live lineage tip is not hidden by older legacy ambiguity and
wallets can use verified lineage or an operator-selected WAB pin.

The no-argument manager retains a bounded in-memory store for isolated tests
and single-process validation. Production construction must pass a `Db` or a
store shared with lookup; do not combine the no-argument manager with the
lookup service's Mongo default.

## Use cases

### Stand up a multi-topic overlay node

Build the manager and lookup maps before constructing the engine:

```ts
import {
  CertMapTopicManager,
  IdentityTopicManager,
  KVStoreTopicManager,
  createCertMapLookupService,
  createIdentityLookupService,
  createKVStoreLookupService
} from '@bsv/overlay-topics'

const managers = {
  tm_identity: new IdentityTopicManager(),
  tm_kvstore: new KVStoreTopicManager(),
  tm_certmap: new CertMapTopicManager()
}

const lookups = {
  ls_identity: createIdentityLookupService(db),
  ls_kvstore: createKVStoreLookupService(db),
  ls_certmap: createCertMapLookupService(db)
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
