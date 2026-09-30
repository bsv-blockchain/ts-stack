---
id: wallet-data-portability
title: 'BRC-38/39 Wallet Data Portability'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: stable
tags: [wallet, backup, interoperability, brc38, brc39]
---

# BRC-38/39 wallet data portability

Use this guide with [Wallet backup and recovery](wallet-backup-recovery.md).
BRC-38 describes a single user's portable wallet records. BRC-39 encrypts that
payload in a password-protected file. Neither supplies root-key recovery.
These are wallet implementation/storage APIs, not new methods on the BRC-100
`WalletClient` interface.

## Standards, implementation and evidence

| Authority                                                     | Where to inspect                                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plaintext record format                                       | [BRC-38](https://github.com/bitcoin-sv/BRCs/blob/master/outpoints/0038.md)                                                                           |
| Encrypted file format                                         | [BRC-39](https://github.com/bitcoin-sv/BRCs/blob/master/outpoints/0039.md)                                                                           |
| Incremental provider synchronization                          | [BRC-40](https://github.com/bitcoin-sv/BRCs/blob/master/outpoints/0040.md)                                                                           |
| Current helper signatures, validation and import semantics    | [Portable storage implementation](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/src/storage/portable/index.ts) |
| Executable SQLite export/restore/merge and rejection examples | [Portable storage tests](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/test/storage/portable.test.ts)          |
| Public versions and migration decisions                       | [Package migration ledger](../reference/package-api-migrations.md)                                                                                   |

Verified against TS Stack main `b2f1989306b6f64677deff89f39596491e448d97`
on 2026-09-24. Recheck the implementation and installed declarations when
upgrading. Pending sync work, including
[#569](https://github.com/bsv-blockchain/ts-stack/pull/569), is not an available
API contract for this guide.

### Unpublished 2.15 source-capture checkpoint

PR #569 now captures BRC-38 source metadata, user and all standard table reads
inside one provider read view. SQLite uses one transaction; MySQL explicitly
requests repeatable-read isolation; IndexedDB uses one readonly transaction
covering settings and the wallet stores. SQLite WAL permits an independent
writer during capture. IndexedDB queues overlapping writers until capture ends;
this checkpoint does not claim bounded foreground write latency for that phase.
A local MySQL 8.4.11 fixture with independent connections verifies source
isolation, enforced read-only access, unchanged session defaults and failure
cleanup. This is not deployed-provider or PXC recovery qualification.

Pass `{ requireSnapshot: true }` to `exportBRC38`, `exportBRC38Json` or the
`exportBRC39` options to require a coherent source view. Custom `StorageProvider`
implementations opt in with `supportsReadSnapshot()` and `readSnapshot(callback)`
and must honor the token on every query. A required but unsupported snapshot
is refused before table capture. Without that option, old custom providers retain
the documented caller-quiesced legacy path; it does not gain a snapshot guarantee.
The callback is for database capture only, without peer I/O or progress handlers.
Source JSON history omits null/undefined values only for recognized optional
object properties in a detached copy, retaining false, zero, empty strings and
every array position. Required values remain subject to validation. A null array
entry is rejected rather than dropped. The source records are not rewritten.

The candidate also adds a local SQL `openReadSnapshot` lifetime with explicit
close/cancellation/expiry and one read at a time. It retains a pinned transaction
across idle periods and occupies a pool connection until physical cleanup.
IndexedDB and remote clients do not gain this capability. The existing export
helpers continue to use their scoped capture path; see
[retained SQL view limits](wallet-sync-reliability.md#retained-local-sql-read-views-unpublished-candidate).

This is an intermediate source candidate, not a released streaming export API.
The materialized helpers below still allocate the full document/file. Remote
snapshot handles, bounded immutable paging, streaming files, staged recovery and
the push/backup scheduling changes remain required parts of the
[full implementation program](https://github.com/bsv-blockchain/ts-stack/blob/codex/wallet-sync-interop-reliability/specs/wallet/sync-portability-program.md).

## Coverage and limits

The implementation exports one `user`, its `sourceStorage` metadata and 13
table arrays: transactions, outputs, output baskets, output tags and maps,
transaction labels and maps, certificates and fields, commissions, linked
proven transactions and proof requests, and sync states. It retains row
relationships, timestamps, tombstones and binary data. This is different from
the 12 entity kinds used in the storage sync protocol; do not use a sync-store
count as the archive schema.

The export does not contain root keys, unrelated manager snapshots, other
profiles, storage-global monitor events, or product data held outside these
tables. Inventory contacts, permissions, external files and custom signing
dependencies in your product before describing its backup coverage.

This exclusion also applies to application-owned tables in the **same database**:
reports, sessions and other custom tables are not discovered or copied by the
portable helpers. Preserving an output does not preserve its application meaning
when that meaning exists only in a custom table. Use standard baskets, tags,
labels and their relationships where their semantics fit; otherwise provide a
separately versioned application export/import and test its links to restored
outpoints. Distinguish durable user content from disposable sessions, caches and
credentials, which must not be copied indiscriminately. A successful wallet
import must disclose any missing application context.

For an older source wallet, check its installed exports and schema before
planning a drill. If the required helpers are absent, preserve the original and
qualify an isolated copy through the supported migration/export path. Record
both versions; importing a file on the candidate does not prove that an older
wallet can produce that file unchanged.

The released helpers read multiple tables and materialize the complete document
and encrypted file in memory. They do not take a database-wide snapshot,
provide streaming archive I/O, expose an archive progress/cancellation API, or
promise a coherent view while other writers change the source. Use a stable
local replica or a database-consistent restored copy. Quiesce its writers and
monitor work while exporting. A lock on one `WalletStorageManager` does not
stop other processes or devices from writing.

The functions require a concrete `StorageProvider`, such as `StorageKnex` or
`StorageIdb`, not a remote `StorageClient`/`StorageMobile` or an arbitrary
`WalletStorageProvider`. For a remote wallet, first synchronize the selected
identity into a compatible local provider through supported storage APIs,
verify that copy, then export it. Do not cast a remote client to
`StorageProvider` or expose unrestricted database methods to make an example
compile. For mobile, choose and qualify a compatible local provider or a
separate trusted export path; a mobile package export does not by itself add
local persistent storage.

`WalletStorageManager.syncFromReader(identityKey, reader)` and
`updateBackups()` are available building blocks. Check their completion/error
results and independently verify coverage before declaring the local copy
complete. With a live changing source, a successful transfer alone is not a
point-in-time consistency guarantee. See the
[storage reference](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/docs/storage.md).

A local synchronized copy has its own storage identity and sync bookkeeping.
Compare wallet data semantically and record that provenance; do not describe
its export as a byte-for-byte copy of the original provider's database.

## Integration references

These public changes provide host-integration examples to inspect alongside
this guide. Status checked on 2026-09-24; an open or merged PR is not evidence
that a store-distributed application version has shipped or passed your drill.

- [BSV Desktop #90](https://github.com/bsv-blockchain/bsv-desktop/pull/90): open
  desktop wallet portability integration.
- [BSV Browser #152](https://github.com/bsv-blockchain/bsv-browser/pull/152): open
  native mobile/browser integration.
- [Peacock Wallet #30](https://github.com/p2ppsr/peacock-wallet/pull/30): merged
  wallet portability and recovery integration example.

Use synthetic data and record both implementations' exact versions for
cross-wallet tests. These examples do not establish universal compatibility.

## API map

The Node package exports the following helpers at `@bsv/wallet-toolbox`.
Browser and mobile roots export the portable helpers through
`@bsv/wallet-toolbox-client` and `@bsv/wallet-toolbox-mobile` respectively;
use the package appropriate to your runtime and qualify its provider/KDF path.

| Helper                                            | Result or purpose                                               |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `exportBRC38(storage, identityKey)`               | Validated `BRC38WalletData` object                              |
| `exportBRC38Json(storage, identityKey)`           | Canonical plaintext JSON string; highly sensitive               |
| `parseBRC38Json(json)`                            | Parses and validates plaintext records                          |
| `encryptBRC39(documentOrJson, password)`          | Encrypts an existing BRC-38 dataset into `number[]` bytes       |
| `exportBRC39(storage, identityKey, password)`     | Exports and encrypts in one operation                           |
| `decryptBRC39(bytes, password)`                   | Authenticates, decrypts and validates before returning records  |
| `importBRC38(storage, documentOrJson, { mode })`  | Writes validated records using explicit restore/merge semantics |
| `importBRC39(storage, bytes, password, { mode })` | Decrypts and imports; no selected-profile confirmation UI       |

Use the library's cryptographic defaults. BRC-39 files conventionally use
`wallet.brc39` and media type `application/vnd.brc39.wallet`. Preserve the bytes;
do not stringify the numeric array and label it a BRC-39 file. Do not trim or
case-fold the passphrase. The helper performs the required NFC normalization.
Its default Argon2id memory cost alone is 128 MiB, in addition to the archive
and runtime allocations. Test realistic files on the lowest supported device.

## Export from a prepared local provider

This TypeScript function uses real public APIs. The caller must supply a
quiesced, verified local data copy for the selected authenticated profile.
File pickers, secret entry, disk permissions and download completion are host
application responsibilities; the function does not persist a file.

```ts
import { exportBRC39, type StorageProvider } from '@bsv/wallet-toolbox'

export async function makeWalletDataFile(
  source: StorageProvider,
  selectedIdentityKey: string,
  expectedChain: string,
  passphrase: string
): Promise<Uint8Array> {
  const settings = await source.makeAvailable()
  if (settings.chain !== expectedChain) throw new Error('Wrong source network')
  const bytes = await exportBRC39(source, selectedIdentityKey, passphrase)
  return Uint8Array.from(bytes)
}
```

Bind identity/network to the selected profile before starting. Keep that
selection stable through completion or abort the host operation when it
changes. Deliver the encrypted bytes through the platform's file API, retain
older known-good copies, and record completion only after the destination save
succeeds. Store a file digest and timestamp as private verification metadata;
neither proves freshness or completeness by itself. Reopen the saved file and
verify it in an isolated recovery drill.

## Preview and import into an isolated target

The following functions illustrate API wiring after the host's resource checks;
they are not a complete untrusted-file admission layer. Before decryption, the
host must bound encoded KDF work/memory parameters as well as file bytes using
a reviewed header parser and a device-qualified policy. A small file can request
expensive Argon2id work. The current helper checks parameter validity but does
not accept a caller-supplied resource ceiling or cancellation signal. Do not
weaken parameters or edit the file to fit a device: refuse it with a supported
recovery path on a suitably provisioned runtime.

Restore into newly provisioned storage with the correct schema and network.
For `mode: 'restore'`, every data table must be empty, including `users` and
`monitor_events`; only settings may exist. A convenience wallet setup can
create a user before import and therefore make the target ineligible. Never
empty a user's existing store to satisfy this precondition.

The caller must already have recovered the selected profile's key and derived
its identity independently. Decrypt first to inspect the archive, compare the
identity/network, obtain the user's confirmation of the target and mode, then
invoke import. Do not trust an archive's identity as the selected profile.

```ts
import {
  decryptBRC39,
  importBRC38,
  type BRC38WalletData,
  type StorageProvider
} from '@bsv/wallet-toolbox'

export async function previewWalletDataFile(
  bytes: Uint8Array,
  passphrase: string,
  recoveredIdentityKey: string,
  expectedChain: string
): Promise<BRC38WalletData> {
  const document = await decryptBRC39(bytes, passphrase)
  if (document.user.identityKey !== recoveredIdentityKey) {
    throw new Error('Archive belongs to a different wallet')
  }
  if (document.sourceStorage.chain !== expectedChain) {
    throw new Error('Archive belongs to a different network')
  }
  return document
}

// Call only after profile/target confirmation. Do not mutate the preview.
export async function restoreConfirmedWalletData(
  emptyTarget: StorageProvider,
  document: BRC38WalletData
) {
  return await importBRC38(emptyTarget, document, { mode: 'restore' })
}
```

Recheck the selected profile and target immediately before committing; reject
a changed selection. Keep the decrypted preview in trusted memory, not logs,
analytics or general application state persistence. Import validates network
compatibility but does not know the UI's active profile or prove possession of
the root key. Import success is data-write evidence, not proof of spendability.

### Restore versus merge

| Mode      | Current behavior                                                                                    | Recovery implication                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `restore` | Checks for empty data tables, inserts rows in a storage transaction and retains exported IDs        | Use an isolated new target with exclusive access; the emptiness check is not a cross-process lock           |
| `merge`   | Finds/inserts the archive identity, uses sync processing and remaps IDs/relationships and sync maps | Protect existing state first; this is not whole-database replacement or a single all-or-nothing transaction |

Do not offer merge as an automatic retry after restore rejects a nonempty
target. Make it an explicit, separately tested product flow for the same wallet
identity. Imported active-storage and sync metadata must not silently authorize
a new endpoint or promote a provider. Restore retains the exported user's
`activeStorage`; the destination retains its own settings. Review authority
and use supported manager operations only after validation. Current import
also normalizes an exact legacy managed-change basket default; the
[managed-change guide](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/docs/managed-change-policy.md)
and portable tests describe that compatibility behavior.

## Resource, privacy and failure handling

Bound file size before reading it into memory, concurrent imports and total
work on the supported device. The current helpers do not expose an
`AbortSignal`; a cancelled UI must not claim that an in-flight write rolled
back. Keep incomplete targets isolated and retain the source/archive for a
controlled retry. Do not lower KDF strength or bypass validation to make an
oversized or malformed file import successfully.

Wrong passwords, damaged authentication tags, unsupported headers and invalid
records must leave the active wallet unchanged. Preserve the original file and
give a clear retry/support path. There is no passphrase-reset function for an
existing BRC-39 file; changing an application login password does not re-encrypt
old exports. Use the [recovery checklist](wallet-recovery-drill.md) for failure,
large-file and cross-runtime tests. Never upload a real export, passphrase,
root key or manager snapshot to an AI agent or public issue.
