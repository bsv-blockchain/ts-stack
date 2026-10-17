# @bsv/wallet-toolbox-mobile

[![npm version](https://img.shields.io/npm/v/@bsv/wallet-toolbox-mobile)](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/wallet-toolbox-mobile)](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)

Mobile build of [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) — the reference [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) wallet implementation. It provides mobile-safe wallet, signer, services, monitor, and remote storage APIs without Knex, SQLite/MySQL native bindings, IndexedDB, or Node-only IO.

Use this package in:

- React Native apps
- Capacitor / Cordova mobile apps
- Other mobile runtimes that provide `fetch`, Web Crypto, and the required web-compatible globals

For Node servers, use [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox). For browsers, use [`@bsv/wallet-toolbox-client`](https://www.npmjs.com/package/@bsv/wallet-toolbox-client).

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

## Provisional delivery budget

The held #569 branch uses provisional artifact allowances based on the complete retained-feature builds. Metro measured 2,765,570 / 729,495 / 558,373 bytes (raw / gzip / Brotli); a 15% allowance sets ceilings of 3,013,000 / 776,250 / 586,500 bytes. The reproducible Hermes build measured 6,116,798 / 2,575,349 / 1,985,367 bytes, about 18.5–20.3% above its original limits. A separate 25% allowance sets Hermes ceilings of 6,368,750 / 2,675,000 / 2,093,750 bytes, leaving about 4–5.5% headroom.

`platform-budget.json` retains the original baselines, measured source and job, owner, earliest review date, and removal conditions. Review follows full implementation, validation, feature completion, and goal achievement. These artifact allowances apply the operator's direction to use measured, judicious limits and are separate from the earlier browser allowance. They do not change exports, dependencies, compiler settings, source maps, licenses, runtime memory, native or production limits, or negative controls. Passing an artifact budget does not qualify mobile behavior or physical devices. Earlier failed samples remain failed evidence.

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
preserving historical rows. No public API or
wire migration is required. Source versions are candidates until published
through the protected release workflow; upgrading an app alone does not
upgrade its remote storage server.

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
App removal or device loss can remove locally retained secrets and state.
Test the independent key and data recovery paths on a replacement device.

Read [Wallet backup and recovery](https://bsv-blockchain.github.io/ts-stack/guides/wallet-backup-recovery/),
[BRC-38/39 integration](https://bsv-blockchain.github.io/ts-stack/guides/wallet-data-portability/) and the
[recovery checklist](https://bsv-blockchain.github.io/ts-stack/guides/wallet-recovery-drill/).
The unpublished 2.15 candidate exports the same snapshot and journal
contracts as the client build. Its `StorageClient` uses the shared authenticated
remote archive and negotiated remote snapshot-destination implementations.
These bind every handle/checkpoint to one identity, network and source, with
finite expiry and transfer limits. Unsupported servers retain their serialized
protocol; they never advertise a partial archive as complete.

This package does not install an IndexedDB or native SQLite provider on a mobile
device. A host native provider must implement and qualify the negotiated
contracts; a remote client is not a local `StorageProvider`. The portable
streaming interfaces and optional asynchronous Argon2id backend are exported
without a Node dependency. A Hermes host must supply a ready interoperable
native backend for strict streaming encryption; Web Worker availability is a
host capability, not a mobile assumption.

`DeviceBackupController` shares only device backup preferences and destination
catalogue IDs. It verifies each profile's identity/network independently and
never shares primary selection or recovery checkpoints. Call `suspend()` on
backgrounding, await original in-flight acknowledgement/cleanup, then `resume()`
on foregrounding. The host owns foreground cadence and atomic preference
storage; constructing the controller starts no timer. Native suspension,
disk-pressure and physical device validation remain outstanding.
See the [implementation map](../docs/implementation-544.md) and
[device lifecycle example](../examples/deviceBackup.ts).

## Large wallet records

Compatible providers negotiate authenticated, integrity-checked transfers for
records that exceed a single HTTP message. Uploads resume saved pieces after
interruption; ordinary pages and legacy providers retain their existing protocol.
Version 1 is bounded to 64 MiB per frame and requires an upgraded provider.
See the [transfer and migration guide](../docs/sync-transfer.md).

## Install

Install the `@bsv/sdk` peer dependency alongside this package:

```bash
npm install @bsv/wallet-toolbox-mobile @bsv/sdk
```

## Package targets

The package publishes:

- an ESM React Native/import target with source maps;
- a CommonJS require target with source maps;
- matching declarations for ESM and CommonJS;
- explicit `react-native`, `import`, and `require` export conditions.

The packed package is validated with Metro and compiled to optimized Hermes bytecode. Node.js 22 or newer is required for the published tooling and contributor workflow, not as an on-device runtime.

The Hermes probe uses a stable relative input filename and verifies identical
bytecode from two independent build directories. Source maps and debug data are
retained; random temporary paths must not affect the unchanged size budgets.

### Password derivation without WebAssembly

Argon2id password derivation uses `hash-wasm` when WebAssembly is available.
React Native engines such as Hermes that do not expose WebAssembly use an
asynchronously yielding JavaScript fallback with identical parameters and
output. Existing UMP v3 wallets remain compatible, and users do not need to
change a device setting or migrate their account.

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
import { Wallet, WalletSigner, WalletStorageManager, StorageClient, Services } from '@bsv/wallet-toolbox-mobile'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'

const chain = 'main'
const keyDeriver = new KeyDeriver(new PrivateKey(privateKeyHex, 'hex'))

// Remote storage over HTTPS is the default mobile-safe backend.
const storageManager = new WalletStorageManager(keyDeriver.identityKey)
await storageManager.addWalletStorageProvider(new StorageClient(keyDeriver, 'https://storage.example.com'))
await storageManager.makeAvailable()

const services = new Services(chain)
const signer = new WalletSigner(chain, keyDeriver, storageManager)
const wallet = new Wallet(signer, services)

const { tx } = await wallet.createAction({
  description: 'mobile send',
  outputs: [{ satoshis: 1000, lockingScript: recipientScript }]
})
```

The mobile wallet includes the built-in BRC-177 `p nosend expiry` module. Its
active remote storage must run a migrated Wallet Toolbox 2.11-or-newer service
and default monitor, which owns expiry enforcement across restarts and devices.
Capability negotiation fails before prefunding against an older server. See
[the full expiry guide](../docs/no-send-expiry.md).

## Use cases

Final overlay identity discovery copies bounded resolver receipts, verifies the
complete transaction graph and canonical anchors with the configured wallet
Services ChainTracker, and validates the standard subject-signed certificate
envelope. Cached transaction evidence is rechecked before use; local contacts
retain their separate policy. See the [identity verification guide](../docs/identity-verification.md)
for C01/C02/C03 compatibility characterization and limits. Inclusion is not
proof of freshness or unspentness. Current package and packed-consumer
validation remains pending the release review.

### Self-custody BSV wallet on a phone

Run the BRC-100 wallet entirely on-device, with remote storage for cross-device sync.

### Companion-app signer for a desktop wallet

Use mobile as the signer over a paired channel while a desktop runs the heavier services.

### Receive-only mobile app

Spin up a minimal wallet that watches for inbound payments via a remote storage backend.

## What's excluded vs `@bsv/wallet-toolbox`

| Excluded                              | Why                                                           |
| ------------------------------------- | ------------------------------------------------------------- |
| `StorageKnex` (SQLite, MySQL)         | Native bindings unavailable on React Native / mobile WebViews |
| `StorageIdb`                          | IndexedDB is not a uniform React Native storage primitive     |
| Node-only filesystem and `os` helpers | Not available on mobile                                       |

The mobile entry includes `Wallet`, `WalletSigner`, `WalletStorageManager`, the mobile `StorageClient`, `Services`, `Monitor`, `WalletPermissionsManager`, `WalletSettingsManager`, `ArcSSEClient`, and related mobile-safe APIs. It does not export `StorageIdb`, `StorageKnex`, `SetupClient`, or test-only chain implementations.

## Wallet snapshot security

Wallet-manager snapshots contain root key material and intentionally include
the decryption key needed by their self-contained format, so access to the
snapshot is access to the wallet. Store the complete snapshot in the iOS Keychain, Android
Keystore-backed encrypted storage, or a comparably trusted secret store. Do not
use ordinary AsyncStorage, logs, analytics, crash reports, clipboard data, or
unprotected device/cloud backups. Treat any snapshot that leaves trusted
storage as a wallet-credential compromise and rotate the affected wallet.

`StorageClient` and credential-bearing Arcade SSE clients require HTTPS for
remote endpoints. Plain HTTP is accepted only for explicit loopback hosts
during development. SSE dependency debug logging is disabled so callback
tokens and authorization headers do not reach device logs.

See the [`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox) README for full documentation.

Prepared BEEF (COOK) persistence is a server-side Knex capability. Mobile
storage keeps the canonical BEEF path, while a compatible remote storage
server can enable prepared reads and writes without a mobile configuration or
wire-format change.

## CORS, CSP, and public services

This client does not impose an origin allowlist. Native mobile requests are not governed by browser CORS, while WebView and hybrid clients can be. A remote Storage service should remain reachable by its intended public apps, WUI, browser, extension, and mobile callers. Operators can keep public access enabled by default or configure an explicit allowlist when their deployment requires one; deployments should not assume a single calling domain.

CSP applies to WebViews or other embedding web applications. Add the service's HTTPS origin to the consuming application's `connect-src` policy. Keep authentication and authorization at the protocol/service layer instead of treating CORS as an authentication mechanism.

## Contributor checks

From the repository root, build the SDK and package before running the installed-consumer mobile gate:

```bash
pnpm --filter @bsv/sdk build
pnpm --filter @bsv/wallet-toolbox-mobile build
pnpm --filter @bsv/wallet-toolbox-mobile test:mobile
```

The gate installs the packed packages in a clean project, bundles them with Metro, checks the public export and mobile-safe module contracts, validates source maps, compiles the result with Hermes, and enforces compressed and uncompressed size budgets.

### 2.15 candidate size review and integration history

The September 28 integration with current main measures Metro **2,401,423 /
619,596 / 468,551** bytes and Hermes **4,646,003 / 1,969,117 / 1,532,602**
bytes (raw/gzip/Brotli), within every retained ceiling. Native module composition,
source maps and Hermes compilation pass.

The reviewed Hermes Brotli ceiling increases from 1,520,000 to 1,675,000 bytes
for bounded resumable sync, proof recovery and prepared BRC-118 payment transport.
The integrated candidate retains main’s subsequently reviewed Metro ceilings
and Hermes raw/gzip ceilings, plus this candidate’s 1,675,000-byte Hermes
Brotli ceiling. No production dependency,
minifier configuration, public export, source-map or compression setting changes
accompany this budget adjustment.

The September 24 candidate, before current-main integration, measured with
official Node 24.18.0:

| Artifact | Raw bytes | gzip bytes | Brotli bytes |
| -------- | --------: | ---------: | -----------: |
| Metro    | 2,377,408 |    609,909 |      463,868 |
| Hermes   | 4,619,927 |  1,955,135 |    1,523,206 |

The approved Hermes Brotli ceiling gives 9.97% headroom after the final forwarding
and normalization refinements. Retaining the explicitly reviewed 1,675,000-byte ceiling
is the rationale for this small difference from the normal 10% margin.
For comparison, [upstream SDK 2.8.3 validation](https://github.com/bsv-blockchain/ts-stack/actions/runs/35948047970)
measured Metro at 2,360,475 / 602,505 / 458,183 bytes and Hermes at
4,609,755 / 1,931,907 / 1,500,120 bytes. The gate continues to inspect the installed
module graph, reject Node-only modules, validate maps and compile Hermes bytecode.
A matching-input cross-platform check produced identical Hermes bytes on Linux
x86_64 and macOS ARM, including reproduction across independent build directories.
These measurements describe this candidate fixture, not an application-size guarantee.

The reviewed 2.14.2 identity candidate `b088c1bef` measures Metro **2,379,919 / 612,262 /
462,261** bytes and Hermes **4,629,563 / 1,943,675 / 1,510,174** bytes
(raw/gzip/Brotli). Compared with the preceding unpublished 2.14.2 candidate,
Metro gzip grows by 3,553 bytes (0.58%). This is the required SDK/Toolbox
identity matcher, portable text tokenization and direct-filter guards; no new
dependency, Node adapter or public export was introduced. The packed consumer
passes the module/runtime composition and source-map checks and compiles with
Hermes. The versioned budgets retain at least 10% headroom above these reviewed
measurements, rounded up to 5,000 bytes, following the shared artifact policy.
All composition and byte-dimension gates remain enforced.

## License

This package is released under the [Open BSV License Version 6](./LICENSE.txt).
The accompanying [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and
[LICENSES/](./LICENSES/) preserve earlier Open BSV grants compiled into the
mobile build.

The unpublished candidate exports version-one retained snapshot, packed row,
field reader and durable sync checkpoint contracts. Provider capabilities are
negotiated independently; importing their types does not enable a backend.
`syncToWriterResumable` and `syncFromReaderResumable` yield between bounded
commits when both adapters support the operation and preserve the exclusive
fallback for older providers.

The browser package's `StorageIdb` has an explicit packed version-one adapter;
`StorageIdb` is not exported by this mobile entrypoint. Passing
`packed` in `StorageIdbOptions` selects a separate schema-version-7 namespace;
it never converts or replaces the default version-6 wallet. Packed providers
implement retained MVCC snapshots, bounded field extents and durable local
merge/checkpoint commits. `readPackedStoragePage` also reads bounded pages from
legacy databases, but those pages alone do not form a retained snapshot.
Logical retention quotas bound records and bytes; they are not browser disk or
process-memory measurements. Keep identity and network explicit for each
profile and preserve the legacy database until a separately qualified migration
has succeeded.

The mobile `StorageClient` negotiates the authenticated single-user archive reader through
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
