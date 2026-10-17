# @bsv/wallet-toolbox-client

[![npm version](https://img.shields.io/npm/v/@bsv/wallet-toolbox-client)](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/wallet-toolbox-client)](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)

Browser build of [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) — the reference [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) wallet implementation. It provides browser-safe wallet, signer, services, monitor, local IndexedDB, and remote storage APIs without the full package's Node-only storage adapters.

Use this package in:

- Web apps that talk to a remote `StorageServer`
- Browser extensions
- Electron renderers

For Node servers, use [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox). For React Native / mobile, use [`@bsv/wallet-toolbox-mobile`](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile).

## Resumable synchronization (2.15 candidate)

`WalletStorageManager.syncFromReaderResumable(identityKey, source, options)` adds
cancellation, durable checkpoints and per-page progress. IndexedDB and Knex local
destinations yield the manager queue during source/proof I/O and between atomic
page commits. Negotiated remote snapshot destinations release the manager queue
while the authenticated server owns its atomic transaction; legacy providers
retain serialized execution. Use
`maxRoughSize: 262144` as a measured starting point for constrained clients;
one oversized record may still exceed this rough page target and is subject to
the provider's separate transfer bound. Resume by invoking the API again: the
destination checkpoint is authoritative, including after a lost acknowledgement.
See the [sync contract and next-stage design](../../../../docs/guides/wallet-sync-reliability.md).
Ordinary replica merge and coherent archive capture are separate APIs. A
replica checkpoint is never substituted for the source archive's original
sync-state rows. Existing BRC-38/39 formats remain unchanged.

## Receiving already-broadcast payments

The 2.14.9 source candidate completes broadcast results even when storage
already marks the request `unmined` or `completed`. This fixes first receipt
without a mining proof on shared storage, and the same result path when another
storage worker advances the request before the broadcast result refresh. The
stored advanced state remains intact; unsuccessful provider results still
reject receipt and do not credit new recipient outputs. Repeated successful
receipt remains idempotent. A payment carrying its valid mining proof follows
the existing proof path without rebroadcast.

Remote SQL storage also needs the 2.14.9 storage migration and coordinated
server rollout: a durable user/TXID claim serializes receipts across pods while
preserving historical rows. The browser's local IndexedDB provider does not
use that SQL claim. No public API or wire migration
is required. Source versions are candidates until published through the
protected release workflow; upgrading an app alone does not upgrade its remote
storage server.

## BRC-100 result compatibility

Version 2.14.1 keeps internal exact-spend accounting off public `createAction`
results, fixing strict binary bridge failures after the wallet operation while
retaining fee and service-charge authorization. Upgrade the wallet and permission
manager together. Existing JSON bridges that remove internal metadata retain their
behavior; no application, BRC-39 or account-recovery migration is required. Check
wallet history before retrying an action whose response failed on an older host.

## Backup and recovery

A BRC-100 wallet needs both recoverable keys and wallet records/derivation
metadata. BRC-39 exports contain wallet data, not root keys or manager snapshots.
IndexedDB can be evicted or lost with the browser profile. Keep an independent
data copy and test recovery on a clean profile.

Read [Wallet backup and recovery](https://bsv-blockchain.github.io/ts-stack/guides/wallet-backup-recovery/),
[BRC-38/39 integration](https://bsv-blockchain.github.io/ts-stack/guides/wallet-data-portability/) and the
[recovery checklist](https://bsv-blockchain.github.io/ts-stack/guides/wallet-recovery-drill/).
The unpublished 2.15 candidate implements coherent retained SQL views and
packed IndexedDB snapshot sources, plus capability-negotiated authenticated
remote archives. `openBrc38IdbSource` and `createBrc38Stream` capture one
identity/network/profile, including all thirteen closure tables and original
sync-state provenance. Packed IDB schema v7 is explicit opt-in; ordinary v6
storage remains available. The packed provider requires a new namespace and
refuses in-place conversion of an existing v6 database. Copy existing data through
the negotiated snapshot/sync path; retain the original v6 database for rollback.
Old binaries must continue using that original namespace.

`previewAuthenticatedBrc39BrowserImport` authenticates a private stream before
returning a data-only preview. `restoreAuthenticatedBrc39BrowserInactive`
performs semantic validation and durable recovery in an isolated packed IDB
profile. `publishAuthenticatedBrc39BrowserProfile` leaves primary selection
explicit; successful decryption or a preview never activates storage.

`encryptBrc39BrowserStreamToQuarantine` writes bounded chunks and withholds the
final authentication tag until the source completes coherently. Install the
fixed trusted worker entry with `installBrowserArgon2idWorker`, await
`BrowserArgon2idWorkerBackend.preload()` and register that exact ready backend.
The streaming export refuses a cold/missing asynchronous backend. The client build emits the self-contained ESM asset
`@bsv/wallet-toolbox-client/argon2id-worker`. Resolve and serve it through the
host bundler as a fixed dedicated-worker asset, or bundle the matching example.
Create a fresh `new Worker(fixedUrl, { type: 'module' })` per backend operation;
never import this side-effecting entry in the main document or choose a worker
URL from archive metadata. The package root remains inert on import.
Native browser execution, memory limits and recovery are still unqualified.
See the [implementation map](../docs/implementation-544.md) and
[worker export example](../examples/browserBackup.ts).

A remote `StorageClient` remains distinct from a local `StorageProvider`.
Request its negotiated authenticated archive API or clearly identify a local
replica source; never label a partial remote replica as a complete archive.

## Large wallet records

Compatible providers negotiate authenticated, integrity-checked transfers for
records that exceed a single HTTP message. Uploads resume saved pieces after
interruption; ordinary pages and legacy providers retain their existing protocol.
Version 1 is bounded to 64 MiB per frame and requires an upgraded provider.
See the [transfer and migration guide](../docs/sync-transfer.md).

## Install

Install the `@bsv/sdk` peer dependency alongside this package:

```bash
npm install @bsv/wallet-toolbox-client @bsv/sdk
```

## Package targets

The package publishes:

- an ESM browser/import target with source maps;
- a CommonJS require target with source maps;
- matching declarations for ESM and CommonJS;
- explicit `browser`, `import`, and `require` export conditions;
- a separate ESM dedicated Argon2id worker asset with its implementation bundled.

Use a current browser bundler such as Vite or esbuild. Node.js 22 or newer is required for the published tooling and contributor workflow; browser runtime support is determined by your application's target configuration.

### Optional native Argon2id backend

Import `registerArgon2idBackend`, `unregisterArgon2idBackend`, and the
`AsyncArgon2idBackend` type from this package's root export. Register a host
implementation only after verifying its interoperability; `isReady()` must
remain false until that verification succeeds. A ready backend is authoritative:
derivation errors and malformed output are surfaced without switching implementations.

Concurrent cold derivations share one background `preload()` attempt and keep
the portable path. Later calls can retry after that attempt settles. Hosts must
make `preload()` and `isReady()` reentrant and cache permanent failures or apply
backoff. Unregister the same backend object when the host no longer owns it.

## Remote storage example

```ts
import { Wallet, WalletSigner, WalletStorageManager, StorageClient, Services } from '@bsv/wallet-toolbox-client'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'

const chain = 'main'
const keyDeriver = new KeyDeriver(new PrivateKey(privateKeyHex, 'hex'))

// Remote storage over HTTPS — no SQLite/MySQL in the browser bundle.
const storageManager = new WalletStorageManager(keyDeriver.identityKey)
await storageManager.addWalletStorageProvider(new StorageClient(keyDeriver, 'https://storage.example.com'))
await storageManager.makeAvailable()

const services = new Services(chain)
const signer = new WalletSigner(chain, keyDeriver, storageManager)
const wallet = new Wallet(signer, services)

// Use the BRC-100 interface as usual.
const { tx } = await wallet.createAction({
  description: 'pay alice',
  outputs: [{ satoshis: 1000, lockingScript: aliceP2PKH }]
})
```

## Use cases

### BRC-100 wallet inside a browser extension

Talk to a remote `StorageServer` over HTTPS, sign locally with a key the user controls.

### Authenticated app with `WalletClient`

```ts
import { WalletClient } from '@bsv/sdk'

const wallet = new WalletClient() // delegates to the user's installed wallet
// ...or build your own with the toolbox classes above
```

### Run an in-app embedded wallet against IndexedDB

```ts
import { StorageIdb } from '@bsv/wallet-toolbox-client'
await storageManager.addWalletStorageProvider(new StorageIdb(...))
```

IndexedDB `listOutputs` results keep `totalOutputs` equal to the full matching
count across every page, including a short final page or an offset at or past
the end.

Prepared BEEF (COOK) persistence is a server-side Knex capability. Browser
IndexedDB keeps the canonical BEEF path, while a compatible remote storage
server can enable prepared reads and writes without a browser configuration or
wire-format change.

The browser wallet includes the built-in BRC-177 `p nosend expiry` module.
Embedded IndexedDB wallets use the default local monitor. When remote storage
is active, its migrated Wallet Toolbox 2.11-or-newer service and monitor own
expiry enforcement; capability negotiation fails before prefunding against an
older server. See [the full expiry guide](../docs/no-send-expiry.md).

## What's excluded vs `@bsv/wallet-toolbox`

| Excluded                      | Why                                     |
| ----------------------------- | --------------------------------------- |
| `StorageKnex` (SQLite, MySQL) | Pulls native bindings; not browser-safe |
| Node-only filesystem helpers  | Not available in browsers               |

The browser entry includes `Wallet`, `WalletSigner`, `WalletStorageManager`, `StorageClient`, `StorageIdb`, `Services`, `Monitor`, `WalletPermissionsManager`, `WalletSettingsManager`, and related browser-safe APIs. It does not promise every full-package or test-only export.

## Wallet snapshot security

Wallet-manager snapshots contain root key material and intentionally include
the decryption key needed by their self-contained format, so access to the
snapshot is access to the wallet. Store the complete snapshot only through a browser or
extension facility backed by an OS Keychain or comparably trusted secret store.
Do not use ordinary localStorage, logs, analytics, crash reports, clipboard
data, or unprotected synchronization. Treat any snapshot that leaves trusted
storage as a wallet-credential compromise and rotate the affected wallet.

`StorageClient` and credential-bearing Arcade SSE clients require HTTPS for
remote endpoints. Plain HTTP is accepted only for explicit loopback hosts such
as `localhost` during development. SSE dependency debug logging is disabled so
callback tokens and authorization headers do not reach application logs.

See the [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) README for full documentation.

## CORS, CSP, and public services

This client does not impose an origin allowlist. A remote Storage service controls its own CORS policy and should remain reachable by its intended public web, WUI, extension, and mobile clients. Operators can keep public access enabled by default or configure an explicit allowlist when their deployment requires one; deployments should not assume a single calling domain.

CSP is an application and deployment concern rather than a package-level access control. Add the service's HTTPS origin to the consuming application's `connect-src` policy. Keep authentication and authorization at the protocol/service layer instead of treating CORS as an authentication mechanism.

## Contributor checks

Final overlay identity discovery copies bounded resolver receipts, verifies the
complete transaction graph and canonical anchors with the configured wallet
Services ChainTracker, and validates the standard subject-signed certificate
envelope. Cached transaction evidence is rechecked before use; local contacts
retain their separate policy. See the [identity verification guide](../docs/identity-verification.md)
for C01/C02/C03 compatibility characterization and limits. Inclusion is not
proof of freshness or unspentness. Current package and packed-consumer
validation remains pending the release review.

From the repository root, build the SDK and package before running the installed-consumer browser gate:

```bash
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/wallet-toolbox-client build
pnpm --filter @bsv/wallet-toolbox-client test:browser
```

The gate installs the packed packages in a clean project, bundles them with Vite and esbuild, checks the public export and browser-only module contracts, validates source maps, and enforces compressed and uncompressed size budgets.

For held PR569, the operator authorized exactly 30% higher browser ceilings on
October 8, 2026: Vite 3,269,500 raw / 780,000 gzip / 598,000 Brotli bytes and
esbuild 2,554,500 / 708,500 / 559,000 bytes. The original values were Vite
2,515,000 / 600,000 / 460,000 and esbuild 1,965,000 / 545,000 / 430,000.
Composition and runtime/test controls remain unchanged. Review these ceilings
after full implementation, validation and feature completion of #544; record
measured opportunities to retain or reduce them. This allowance does not establish
artifact, functional or production readiness.

## License

This package is released under the [Open BSV License Version 6](./LICENSE.txt).
The accompanying [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and
[LICENSES/](./LICENSES/) preserve earlier Open BSV grants compiled into the
browser build.

### Local sync database upgrade

IndexedDB automatically upgrades to schema version 6, adding a non-unique
transaction-ID/user index without replacing wallet records. Exact transaction,
reference, reclaim, commission, and relation lookups avoid repeated full-wallet
scans during restores. Legacy duplicate transaction IDs remain intact. Clients
that request an older IndexedDB schema version cannot reopen this database;
retain a compatible client when using the local backup.

The unpublished candidate exports version-one retained snapshot, packed row,
field reader and durable sync checkpoint contracts. Provider capabilities are
negotiated independently; importing their types does not enable a backend.
`syncToWriterResumable` and `syncFromReaderResumable` yield between bounded
commits when both adapters support the operation and preserve the exclusive
fallback for older providers.

The browser `StorageIdb` has an explicit packed version-one adapter. Passing
`packed` in `StorageIdbOptions` selects a separate schema-version-7 namespace;
it never converts or replaces the default version-6 wallet. Packed providers
implement retained MVCC snapshots, bounded field extents and durable local
merge/checkpoint commits. `readPackedStoragePage` also reads bounded pages from
legacy databases, but those pages alone do not form a retained snapshot.
Logical retention quotas bound records and bytes; they are not browser disk or
process-memory measurements. Keep identity and network explicit for each
profile and preserve the legacy database until a separately qualified migration
has succeeded.

`StorageClient` negotiates the authenticated single-user archive reader through
`getSnapshotArchiveTransport(identityKey)`. Its `getSnapshotSync()` source
adapter opens immutable, expiring remote views for ordinary resumable copies to
compatible local destinations. Each view retains the original source settings,
user and all thirteen standard tables, including original sync-state rows.
Those original sync states are archive provenance; a replica's destination
checkpoint is separate. `snapshotArchives: false`, old peers and unsupported
server configurations decline the source capability. A migrated server separately
advertises `snapshotSyncDestination` for bounded, authenticated full-row merge
pages. The manager releases its queue after dispatch; the server atomically
commits entity effects, ID mappings and the durable checkpoint under fresh
session and primary fences. Replies are limited to 16 KiB. Pages admit at most 128 rows and 10,000,000
charged allocation bytes, intersected with caller limits. Frames above the
512 KiB inline ceiling use the existing durable transfer store with 256 KiB
parts and a 16 MiB total frame ceiling. The staged result, entity effects, maps
and checkpoint commit in one original SQL transaction. One page remains in
flight under one 30-second I/O deadline across its upload and commit. A timeout does not establish whether the server committed: observe its
durable checkpoint before recovery. Old or disabled destination peers retain
the exclusive compatibility path. Rows that exceed the negotiated page/frame budget refuse; remote field
extents are not advertised by this protocol. Staging retains the original source
expiry, and authenticated cleanup remains available after expiry. A failed
release retains its concrete original transfer cleanup for retry.
Raw archive frames use storage-key ordering and must not be presented directly
as canonical BRC-38 output.

Portable exports include `createBrc38Stream`, `openBrc38IdbSource` and bounded
BRC-39 browser processing. The browser import entrypoints
`previewAuthenticatedBrc39BrowserImport`, `restoreAuthenticatedBrc39BrowserInactive`
and `publishAuthenticatedBrc39BrowserProfile` authenticate the complete original
envelope, verify semantic/proof closure and use isolated staging with durable
recovery state. Preview is data, not an activation grant; publication preserves
original primary and sync values as provenance. The IDB implementation requires
an actual IndexedDB host and explicit resource policies. The Node native SQLite
controller has a separate entrypoint and runtime contract.

These are working-source implementation contracts, not release or physical
platform acceptance claims. Browser/native/mobile suspension, disk pressure,
packed-consumer compatibility, independent format vectors and performance
qualification remain required before downstream adoption. See the
[wallet sync and migration guide](../../../../docs/guides/wallet-sync-reliability.md).

## WAB faucet fee compatibility

Version 2.14.6 carries the local signer's independently validated fee/change
outputs through the permissions manager to SDK completed-action binding. Upgrade
with an SDK exposing `completeBoundAction.outputAuthorizationVersion=1`; older SDK
peers preserve their strict behavior and do not receive the fee-bearing faucet
fix. Use wallet and authentication manager from the same package instance.
Serialized results discard local authorization. See the full toolbox README for
SDK3 migration and the unchanged signup retry/reconciliation limitations.

## Pre-construction conflict recovery

The held 2.15.0 candidate preserves remote storage's empty attempted-TXID sentinel
only for a bounded double-spend review before transaction construction. It does
not authorize a retry. Applications must verify complete competing transactions
against the requested explicit inputs, synchronize the accepted winner, then
read fresh state before rebuilding. Upgrade the application SDK alongside the
wallet parser. Use the existing JSON wallet API for structured review errors;
the binary wire format is unchanged. No database or call migration is required.
