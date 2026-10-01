# Wallet sync and portability implementation program

Issue [#544](https://github.com/bsv-blockchain/ts-stack/issues/544) is the acceptance
contract for this program on [#569](https://github.com/bsv-blockchain/ts-stack/pull/569).
The PR remains open, unmerged and draft while implementation or qualification is
incomplete. A green intermediate source revision does not complete this program.

## Baseline and immediate defect

At `ec12ee79deb69d2019b3e50ee70d975752293d0b`, `syncFromReaderResumable` yields
between atomic local destination commits. `syncToWriter`, ordinary
`syncFromReader`, `updateBackups` and primary reconciliation still hold exclusive
manager ownership across entire copy loops. Near-realtime backup therefore still
blocks foreground wallet operations. Existing benchmarks cover pull scheduling,
not this push/backup acceptance case.

Removing those locks alone is insufficient. A source can change between live
offset pages, and an old source reply can overlap primary replacement. Source
isolation, checkpoint ownership and generation fencing must accompany yielding.
Existing BRC-38 capture also reads tables independently and materializes the
complete archive; a local replica export cannot stand in for original remote
source metadata and sync-state history.

## Required checkpoints

Each row remains open until its implementation **and** evidence are complete.
The sequence permits intermediate commits, not permanent scope deferrals.

| ID  | Required result                                                                                                                                                                                                              | Code and evidence boundary                                                                                                                                                               | Baseline                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| S1  | Both directions, ordinary backup and primary reconciliation use bounded resumable work; foreground reads/writes proceed outside atomic commits; fair background admission; explicit cancellation and stale-session rejection | `WalletStorageManager`, `storage/sync`; delayed peer, queued cancellation, lost acknowledgement, concurrent sessions, replacement and restart tests; push and pull traces                | Pull subset only                              |
| S2  | Coherent provider read views, stable indexed keysets and immutable high-water positions preserve closure, equal timestamps and tombstones under monitor/device writes                                                        | `StorageProvider`, `StorageKnex`, `StorageIdb`, schemas and migrations; independent writers, process termination, query plans and bounded page tests                                     | Missing coherent view/keysets                 |
| S3  | Negotiated authenticated single-profile remote snapshot/export handles bind identity, network, source schema/version and immutable content; quotas, expiry, bounded cursors and cleanup                                      | `StorageClientBase`, `StorageClient`, `StorageServer`, shared contracts; real authenticated HTTP, old/new combinations and expiry/restart evidence                                       | Missing                                       |
| S4  | Bounded metadata/blob transport with integrity-checked content reuse, explicit row/byte/in-flight limits, adaptive page control, no repeated full counts/maps, optional measured read-ahead with ordered commits             | Sync transfer, provider queries and packed adapters; large individual row, high fixed latency, table-transition and backpressure tests                                                   | Binary transfer/controller subset only        |
| P1  | Canonical streaming BRC-38 contains all standard tables and relations plus original source provenance/sync state from one snapshot; optional legacy object fields normalize without mutation or lost array values            | `storage/portable`, shared vectors and independent reader/writer; full closure, nullable history, binary/order and concurrent capture tests                                              | Materialized non-snapshot capture             |
| P2  | Bounded BRC-39 encryption/decryption and file processing retain the exact envelope, NFC password handling, canonical Argon2id strength and complete authentication before activation                                         | Portable codec, worker/native backends and bounded transferable/IPC adapters; independent bytes, wrong password, corrupt/truncated/oversized inputs, progress/cancel and memory evidence | Materialized file processing                  |
| P3  | Import preview, isolated durable staging, semantic validation, ID remapping, repeat import and a durable commit/recovery journal; preserve provenance/primary history without automatic activation                           | Portable import, storage migrations/journal; kill/restart at every durable boundary, empty/occupied targets, repeat merge and disk-pressure tests                                        | Legacy restore/merge subset only              |
| A1  | One wallet identity/network/profile throughout every export/import/sync; supported versioned packed IDB/native adapters and downstream migration removing coarse queues/private schema copies                                | Public core/client/mobile artifacts and host example; independent profiles, native browser, supported native databases and mobile lifecycle                                              | Partial existing platform artifacts           |
| V1  | Reproducible per-backend and combined performance/fault/conformance evidence with foreground p50/p95/p99, lock/queue time, cancellation, wall/wire/CPU/query/memory costs and quiescent unchanged copies                     | SQLite, IndexedDB, authenticated remote; small/large wallets and rows, cold/incremental/no-change/export/import, latency/disconnect cohorts                                              | Pull-only benchmark baseline                  |
| V2  | Complete affected packages, packed consumers, docs, conformance, property/mutation, analyzer and exact-head hosted repository gates                                                                                          | Root governance and CI; no relaxed thresholds, hidden findings or substituted platform claims                                                                                            | Earlier head qualified only                   |
| R1  | Released packages, provider rollout, consumer migration and explicitly authorized funded restore/spend plus required physical platform drills                                                                                | Protected release/deployment workflows and host/operator acceptance records                                                                                                              | Separate authorization and execution required |

## Compatibility and data boundaries

- Additive capabilities precede their use. Unsupported providers retain the safe
  serialized path and explicitly refuse unsupported complete source exports.
  Old/new combinations must not silently advertise stronger guarantees.
- Preserve released APIs, BRC-38/39/40 encodings, error identities and inclusive
  timestamp behavior. New cursor/schema contracts are versioned and tested with
  resumable upgrades and documented downgrade constraints.
- BRC-38 v1 deliberately excludes pending action batches, auxiliary runtime
  tables, application-specific tables and storage-global logs. Do not settle
  pending batches or invent an archive extension to make export work.
- Preserve historical managed-change policy in archive bytes. Operational
  migration is separate from faithful export/import provenance.
- Key recovery and wallet-data recovery remain distinct. All automated fixtures
  use synthetic records; production keys, archives, payloads and identities do
  not enter telemetry, public coordination or source evidence.
- Keep all memory, temporary disk, retention, queue and KDF limits explicit.
  Cancellation before commit discards staged work; cancellation during a commit
  reports the durable outcome before stopping. No unverified plaintext becomes
  active wallet data.

## Completion evidence

The first implementation checkpoint adds local provider read views and threads
their token through every BRC-38 capture query, including uncached source
settings. Built-in providers use that view automatically. `requireSnapshot`
requests the guarantee explicitly and refuses unsupported providers before table
reads; existing custom-provider calls keep their caller-quiesced compatibility
path. Tests cover an independent SQLite WAL writer, queued IndexedDB writes,
failure cleanup, profile separation and stale settings caches. Optional legacy
JSON fields normalize without changing source history; required values and array
entries cannot be silently dropped. Inconsistent owned label/tag mappings reject
capture instead of being filtered out of the archive.

The next checkpoint adds a bounded local SQL read-view lifetime. Opening pins a
SQLite/MySQL view before returning, retains it across idle reads, rejects nested
or concurrent reads, and keeps provider capacity occupied until physical cleanup
after close, expiry, cancellation or read failure. Tests cover exact lifetime
boundaries, delayed acquisition/initialization/read/cleanup, independent writers,
profile-filtered reads and randomized operation schedules. The local methods are
absent from the RPC allowlist. Each view occupies one pool connection; query
cancellation/deadlines remain a driver concern. Retention is explicitly
unsupported on IndexedDB. No persisted schema or index transition is introduced.

The subsequent local SQL page contract binds one profile and source metadata to
the retained view, returns all thirteen standard tables through keyset cursors,
and preflights payload sizes before fetching rows. Binary fields remain packed.
Retries within a view repeat pages; a new view rejects its predecessor's cursor.
Existing unique keys avoid changing legacy OFFSET traversal. Composite storage
order is explicit and differs from canonical archive order. This provides
bounded local pages, with explicit oversized-row refusal pending streaming.

The durable local integration checkpoint connects supported ordinary push, pull
and backup calls to those pages. A dedicated SQLite-WAL/static-MySQL reader leaves
foreground pool capacity available. The destination commits entity rows,
normalized bounded ID mappings and its cursor atomically. An additive auxiliary
migration and database-owned primary epoch fence stale pages, including independent
away-and-back changes. Same-view lost acknowledgements resume the destination
checkpoint; replacement source views restart traversal with retained mappings.
Tests terminate the destination process before a row, before checkpoint update,
before transaction commit and after commit/before acknowledgement, then recover
and finish without duplicate rows or partial checkpoints.

The subsequent internal SQL staging component adds shared immutable-page storage
for remote snapshots. It binds profile/source metadata, reserves bounded logical
capacity, commits pages and retry receipts atomically, and retains capacity until
resumable cleanup finishes. Independent-connection SQLite/MySQL and actual SQLite
process-termination fixtures cover its persistence boundaries. The local capture controller
now binds metadata and the migration version to the same SQL read view, checks
profile relationships without full ID maps, and captures all thirteen raw tables
into bounded binary frames. SQLite generated cases and a MySQL independent-writer
fixture exercise capture and cleanup. Canonical portable semantic validation,
authenticated client/server integration, larger-wallet resource policy and
measured physical storage costs remain open. The migration and local controller
do not expose or advertise a remote snapshot API.

The internal directory component now authenticates every page receipt under the
complete root chain and builds a fixed thirteen-table index. SQL reads select
only bounded receipt metadata, retain the original binding bytes and recheck
profile/expiry after I/O. A separate verifier binds expected source/profile/root,
rejects malformed metadata and checks each detached payload against its verified
receipt. Independent SHA-256 fixtures, 300 generated directory cases, maximum
size boundaries and cross-connection SQL capture reads exercise this contract.
This advances S3 table positioning without adding a remote endpoint, negotiating
capabilities or establishing portable semantic/proof validation.

The durable request-lifecycle foundation reserves shared capacity before source
acquisition and atomically assigns an archive and publishes its ready receipt.
Its immutable deadline is part of request identity, so bounded receipt collection
does not allow an old request to reopen. A separate auxiliary migration retains
bounded terminal history and cleanup ownership. SQLite fault and generated
schedule tests cover these persistence rules. The local service controller now
integrates the existing owned source slot and shared capture path, reserves before
pool acquisition and drains cancellation/shutdown before releasing its admission.
Ready publication follows physical reader cleanup; failed cleanup fences the
controller, and completed archives survive replacement.

The subsequent authenticated HTTP layer now negotiates the migrated WAL/MySQL
archive capability, returns prompt durable admission and accepts exact profile-bound
status/directory/page/cancel requests. Full and mobile client transports enforce
a dedicated response cap before parsing and bind immutable receipts, source
metadata and page inclusion. Actual synthetic HTTP tests cover lost admission,
replacement, cross-profile refusal and physical shutdown. Admission invokes
expiry cleanup; explicit resource-limit terminal status remains distinct from
other failures. This advances the S3 transport portion. The clock/cursor-compatible
remote row reader, sync-manager adoption, remote destination, portable semantics
and performance qualification under contention remain open.

The next unadvertised reader implementation adds distinct server-issued v2
offers, require-existing admission, bounded exact-request retry, fixed client
leases and verified packed row paging. Successful explicit close can collect a
reader receipt without reopening it; failure receipts remain pollable until
cancellation or expiry. The client source adapter and local manager/destination
integration detach, compare and persist optional archive positions and preserve
typed cancellation without treating unrelated failures as cancellation or
fallback. Actual full/mobile HTTP fixtures cover all thirteen row schemas,
replacement, admission loss and cancellation, alongside a generated reader
property. A complete-suite restart failure exposed a reused HTTP connection
reset; immutable requests now permit one native-fetch retry without renewing
the lease or retrying authentication failures. Actual full/mobile HTTP-to-local
sync fixtures retain durable positions on cancellation and complete a later
view into an occupied profile without duplicate labels. The production server reader setting remains absent pending owner
recovery and physical cleanup qualification across replicas. This checkpoint
does not complete S3, V1, remote destination support or portable export/import.

These checkpoints advance parts of S1/S2/P1/S4. They do not complete primary
reconciliation, indexed identity/update predicates and commit-order high-water
positions, authenticated remote views, durable source views, streaming or staged
restore. Large-row/reference/retention limits still use serialized fallback.
IndexedDB writers wait during capture and legacy archive helpers still materialize
the document. Local MySQL fixtures qualify their isolated version/configuration;
they do not qualify deployed MySQL/PXC behavior or physical mobile execution.

For every checkpoint record the exact source revision, commands, fixture and
platform, measured result, compatibility result and remaining limitation. Link
evidence to the requirement it actually demonstrates. Native browser evidence
does not qualify physical mobile execution; synthetic signing does not qualify a
funded restore/spend; source CI does not constitute publication or deployment.

The implementation goal stays active until all required work is complete or an
explicit external dependency prevents further progress. Prepare concrete release,
deployment and funded-drill artifacts before requesting the separate operator
authorization those actions require. PR #569 must remain open even when complete.

The source-owner fence checkpoint adds an auxiliary exact-claim slot before
service capture and retains archive/request quota through physical cleanup.
Cross-controller cancellation stops the next atomic append; request and direct
archive cleanup both refuse to release outstanding owners. Ready publication
follows the same cleanup acknowledgement. This closes premature logical release
but deliberately does not reclaim unproved process loss: backend-bound recovery
remains required. The client now validates exact pending-cleanup receipts and
uses fixed, bounded cancellation polling while awaiting I/O settlement. The server reader capability stays
off and S3 remains open.

The backend-guard checkpoint adds eight persistent slot bindings and a versioned
owner migration. New service sources bind local SQLite WAL file identities or
the actual MySQL server/database before their guarded read; old unguarded owners
remain reserved. Recovery takes the same backend guard, fences the exact expired
or terminal claim, physically closes its proof connection and only then releases
ownership. SQLite keeps its guard transaction open through native destruction;
MySQL waits for the socket close event. Focused and generated tests cover delayed
acquisition/close, immutable views, foreground writes, stale acknowledgements,
slot reuse and changed identities. Built-artifact SQLite/MySQL fixtures terminate
an owned synthetic process and recover its claim. This advances S3 orphan
recovery but does not qualify distributed filesystems, PXC, global physical-pool
limits, remote destinations or complete lifecycle/performance behavior. Reader
advertisement remains disabled and the full program remains incomplete.

Provider lifecycle qualification also preserves an unproved cleanup failure
after the retained read promise settles. The provider keeps its source slot
fenced and destruction exposes that error; an ordinary read failure remains
retryable after proved physical cleanup. Regression tests cover both opening
and closing failures, shared recovery admission, shutdown drainage, immutable
request bindings and exact cancellation outcomes. These checks do not replace
the complete mutation campaign or exact-head hosted qualification.
