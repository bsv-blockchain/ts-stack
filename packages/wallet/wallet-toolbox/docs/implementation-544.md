# Wallet sync and portability implementation map

This map identifies the current implementation and its focused tests. Use the
[acceptance contract](../../../../specs/wallet/sync-portability-program.md) for
PR569 readiness and the [wallet guide](../README.md#sync-and-recovery-reference)
for application-facing documentation. Historical checkpoint logs are retained in
Git history rather than repeated as current requirements.

## Coordinator and storage

| Required behavior                                                          | Concrete implementation                                                                                              | Authored coverage                                                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Atomic page ownership, foreground fairness, bounded queue and cancellation | `WalletStorageManager`, `StorageAccessQueue`, `commitSyncAdmission`, `runPullSession`, `runSnapshotSyncSession`      | Queue unit/generated cases; sync-session and snapshot-session cases; manager transition/journal cases                        |
| Explicit reentrancy and current primary fence                              | Borrowed `runAsSync(callback, activeSync)`; generation/provider/identity checks under ownership                      | Manager provider-transition, primary-switch and stale-work cases                                                             |
| Durable destination acknowledgement and restart                            | Snapshot sync destinations; journal reconciliation/status recovery; durable normalized ID mappings                   | Lost-reply, replacement-manager, interrupted writer and rollback cases                                                       |
| Coherent local capture and indexed keysets                                 | `KnexWalletReadSnapshot`; retained SQL RC/RR/WAL views; `openPackedIdbSyncSource`; journal receipts/high-water/floor | SQL isolation, same-timestamp, full closure, tombstone and retention cases                                                   |
| Packed IDB and bounded large fields                                        | Packed v7 fields/versions, binary chunks, UTF8/UTF16 and structured-field preparation                                | Large-row, staged-reference, atomic rollback, corruption, quota and physical-retirement cases                                |
| Adaptive byte/latency budget                                               | `SyncPageBudget` fixed versus marginal fitting, smoothing, hysteresis and bounded upward probes                      | Unit/generated fixed-latency, large-proof and table-transition cases                                                         |
| Authenticated full source archive                                          | `StorageClientBase` + `StorageServer` + snapshot archive RPC/service/remote source                                   | Authenticated HTTP, all thirteen original tables, identity/network, expiry, quota, close/recovery and old/new cases          |
| Negotiated remote destination                                              | `RemoteSnapshotSyncDestination`, `KnexRemoteSnapshotSyncRpc`, durable transfer/checkpoint tables                     | Real HTTP/SQL held-I/O, foreground access, primary replacement, multipart, malformed data, lost reply and atomic fault cases |
| Raw bytes with legacy interoperability                                     | Binary JSON negotiation and bounded snapshot-transfer pieces                                                         | Binary/JSON peers, integrity and ordinary legacy chunk cases                                                                 |
| #542 returned error handling                                               | `throwSyncResultError` before counters/checkpoints/completion in every chunk consumer                                | Third-party returned errors and unfinished no-progress refusal                                                               |
| #543 basket mapping                                                        | Shared output merge policy validates non-null parent mapping and repairs existing output basket association          | Missing mapping, repeat merge and stored-row repair cases                                                                    |

The original request admission is retained across availability I/O and read-mode
reselection, so the wait-queue bound cannot be bypassed by pending initialization.
It bounds request count, not arbitrary caller payload bytes.

Reads and proof preparation occur outside atomic destination ownership. A queued
cancellation cannot invoke the operation. Once invoked, the original commit and
its actual durable ACK/failure are awaited; cancellation cannot turn a lost reply
into a fabricated zero-progress result. Journal custody observations intentionally
remain available after cancellation. Legacy providers retain serialized execution.
Read-ahead is an evaluation item: this candidate retains one ordered page in
flight, rather than enabling unmeasured parallel readers or writers.

## Portable archive and recovery

| Required behavior                                                   | Concrete implementation                                                                                                    | Authored coverage                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Canonical streamed BRC-38, nullable histories and source provenance | `createBrc38Stream`, streamed rows/structured fields, coherent native/IDB/remote sources                                   | Independent canonical vectors, all thirteen tables, exact binary/structured values, nullable fields and non-mutating captures |
| Node streamed BRC-39                                                | `Brc39StreamNode`, owned one-shot Argon2 worker/ready native backend, native GCM                                           | Independent NFC/KDF/GCM bytes, abort and actual worker exit, strength, corrupt/truncated/oversized files and private staging  |
| Browser streamed BRC-39                                             | Browser stream export, `Brc39WebCryptoGcm`, authenticated streamed browser staging                                         | Independent native GCM oracle, arbitrary chunk/block boundaries, private quarantine, cancellation and final-tag withholding   |
| Asynchronous worker/native KDF                                      | First-party browser Worker backend + explicit installer; optional ready host-native backend                                | Native browser Worker/NFC/foreground cases and selected-backend failure/input-erasure cases                                   |
| Authenticated import preview                                        | Native private preview and browser `previewAuthenticatedBrc39BrowserImport`                                                | Data-only preview, wrong identity/network/password, original provenance and cleanup cases                                     |
| Isolated semantic restore and repeat merge                          | Native composed import/recovery and browser `restoreAuthenticatedBrc39BrowserInactive`                                     | Empty/occupied/repeat targets, all entity policies/relationships, actual stored bytes, restart and no implicit activation     |
| Publication, explicit selection and retirement                      | Native publication receipts/catalogue/current observer; browser publication/profile selection/retirement                   | Lost-ACK recovery, inactive versus selected state, manager reopen, changed data, expiry and physical cleanup cases            |
| Native physical custody                                             | Common private filesystem bridge; Unix driver; Windows original HANDLE/DACL/image/job implementation and candidate recipes | Authored platform identity/privacy/cleanup and retained native contract cases; Windows execution remains unqualified          |

BRC-38 includes original source settings/user metadata and its thirteen closure
tables. It excludes root keys, pending action batches, auxiliary runtime tables
and storage-global logs. Restore preserves historical managed-change values;
any later operational policy upgrade is explicit. Import success is data recovery,
not proof of key recovery or permission to activate a primary.

Packed IDB v7 uses a new namespace and rejects in-place v6 conversion. Copy data
through the negotiated path and retain the original v6 database for rollback.
Never reset an existing database. A private restored profile remains inactive
until an explicit, currently fenced selection operation succeeds.

Node KDF admission is per installed module instance, not a kernel-wide memory
quota. Browser Worker termination is the native browser API call; browsers expose
no process-exit receipt. Windows executable/addon/supervisor qualification tables
remain empty until actual host qualification. None of these limitations may be
relabelled as verified physical platform behavior.

## Device and consumer integration

`DeviceBackupController` shares only bounded versioned device preferences
(automatic backup and host catalogue destination IDs). Every participating
profile has its own identity, network, manager, provider and durable checkpoint.
There is no shared primary choice, archive identity or recovery journal. Unknown
preference versions refuse; supported legacy preference values are preserved.
The host explicitly persists migration through atomic preference storage.

Construction launches no backup or timer. The host calls foreground cadence,
`suspend()`, `resume()` and `close()`. Suspension cancels queued work but joins the
actual original in-flight commit and cleanup; failed cleanup fences reuse and
retains its concrete retry owner. `examples/deviceBackup.ts` demonstrates this
lifecycle. Node, client and mobile entrypoints export the controller and shared
contracts. The mobile build supplies authenticated remote storage, not an
installed native SQLite/IndexedDB provider. Native host providers/KDFs and
physical suspension behavior require separate device qualification.

The packed current-row and restore-journal comparisons share one complete
metadata-data comparator. It compares every field, extent and genuine Date
internal slot, including native structured clones from another realm. Every
caller independently repeats its original current transaction, source, primary,
profile, revision, schema, content and expiry checks; equality confers no owner
or retained admission result.


## Validation

Run the affected wallet and transport tests and the repository's applicable
foreground checks. The operator's managed TTN wallet is the native acceptance
case: preserve its controlled outputs, certificates and metadata, complete a
payment, synchronize a device copy, restart and verify retained state. The
network-ops dossier records deployed source identity and raw evidence locations.

Mutation campaigns, exhaustive fault/platform matrices, performance research and
historical receipt regeneration are follow-up work. A reproduced data-loss,
authorization or payment defect still blocks release until resolved.

Normal wallet CI selects six ordinary shards and the zero/one-second HTTP cases.
The complete extended native recovery/fault matrix remains available through
manual CI with `extended-wallet-qualification`; its cases and receipt validation
are preserved. Coverage percentages and bundle byte targets inform review without
preventing selected functional tests from running. Native worker admission follows
the supported Node24.11+ floor at module ABI137 and records the actual runtime.
