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

These checkpoints are only part of S2/P1/S4. They do not yet implement indexed
identity/update predicates and commit-order high-water positions, authenticated
remote views, durable source-view checkpoints,
streaming, bounded push/backup work or staged restore.
IndexedDB writers wait during capture and the legacy helpers still materialize
the document. A local MySQL 8.4.11 fixture confirms repeatable-read capture under
an independent writer, read-only enforcement, unchanged session defaults and
failure cleanup. Deployed MySQL/PXC behavior is not qualified by that fixture.

For every checkpoint record the exact source revision, commands, fixture and
platform, measured result, compatibility result and remaining limitation. Link
evidence to the requirement it actually demonstrates. Native browser evidence
does not qualify physical mobile execution; synthetic signing does not qualify a
funded restore/spend; source CI does not constitute publication or deployment.

The implementation goal stays active until all required work is complete or an
explicit external dependency prevents further progress. Prepare concrete release,
deployment and funded-drill artifacts before requesting the separate operator
authorization those actions require. PR #569 must remain open even when complete.
