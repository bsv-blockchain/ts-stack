---
id: wallet-sync-reliability
title: 'Resumable wallet synchronization and proof recovery'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: beta
tags: [wallet, sync, storage, performance]
---

# Resumable wallet synchronization and proof recovery

The unpublished Toolbox 2.15 candidate provides a complete bounded pull-sync
session for local Knex and IndexedDB destinations. Source requests, proof-provider
I/O and progress callbacks run outside exclusive page ownership; the destination
commits each page and its checkpoint atomically. Foreground reads and writes can
proceed between commits. Remote/custom destinations retain the established
exclusive path unless their local provider explicitly supports the required
capability. Existing `syncFromReader`, `syncToWriter` and their result contracts
remain available.

## Consumer contract

```ts
const controller = new AbortController()
const result = await manager.syncFromReaderResumable(identityKey, source, {
  signal: controller.signal,
  maxItems: 1000,
  maxRoughSize: 262144,
  onProgress: progress => {
    // Render counters and state; keep this callback short and non-throwing.
    console.log(progress.state, progress.pages, progress.inserts, progress.updates)
  }
})
```

The result reports `completed` or `cancelled`, actual `paged` or `exclusive`
execution, acknowledged page/entity counts and the last durable checkpoint.
Progress includes reading, preparing, committing, committed and terminal states,
with separate source-read, preparation, queue and commit timings when available.
A callback exception rejects the call; resume from the destination rather than
assuming that no page committed.

Cancellation is cooperative. It waits for an in-flight source read or proof
lookup to drain, discards an uncommitted page, and waits for an already-started
commit acknowledgement. It does not abort a database transaction after its
outcome becomes uncertain or undo acknowledged data. Invoke the API again to
resume; do not use UI counters as a checkpoint. A lost acknowledgement rejects
without automatically replaying a write, and the next session loads the durable
destination state. The retained local SQL path distinguishes resuming a still-live
view from restarting a replacement view, as described below.

Only one page is in flight. The new API defaults to 1,000 rows and 262,144 rough
encoded bytes (256 KiB). Options must be positive safe integers, no greater than
1,000 rows and 10,000,000 rough bytes. Existing sync methods retain their prior
defaults. The new default is a measured starting point for constrained clients,
not a universal memory ceiling. A single large record can exceed a rough page target;
the existing separately negotiated 64 MiB transfer-frame bound still applies.
See [bounded transfers](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/docs/sync-transfer.md).
There is no unbounded prefetch queue or hidden parallel merge.

## Identity, network and persistence safety

Missing, unrecognized or mismatched chain declarations fail with the existing
`WERR_NETWORK_CHAIN` before sync state or user writes. Live sync never infers a
provider's chain. Legacy providers without access capabilities retain exclusive
ownership; they still need matching chain declarations. Both sync directions
honor returned `ProcessSyncChunkResult.error` values as well as thrown errors.
Neither path advances counts or checkpoints after an error, and a nonterminal
page that makes no checkpoint progress fails explicitly.

A completed unchanged backup may reset all twelve legacy offsets to zero while
retaining its `since` timestamp. Clients accept that reset only with literal
`done: true`; nonterminal and partial offset retreats still fail. State identity
and timestamp monotonicity are checked on terminal replies too. This fixes the
`Invalid sync checkpoint` error on repeated ordinary HTTP backups without
changing checkpoint JSON or persisted state. A lost terminal acknowledgement
still resumes by loading the destination's durable checkpoint. A returned
provider failure takes precedence over any accompanying checkpoint fields.

Sessions pin wallet identity, destination instance and manager generation.
Switching/destroying the destination fences late replies before mutation. The
page commit rechecks the durable checkpoint and any proof rows inspected during
preparation, preventing concurrent sessions or monitor repairs from overwriting
newer state. Input pages and checkpoint values are detached before asynchronous
validation. Legacy checkpoints retain their schema; the durable local SQL path
below adds auxiliary persistence. No archive envelope changes.

The queue permits at most eight concurrent readers on providers advertising safe
reads. Writers remain exclusive. Foreground work has priority, with bounded
bypass (eight grants or one second of queue age) so background sync can still
progress. Legacy providers remain exclusive. Advertising a capability is a
provider correctness promise, not merely a performance hint.

The adaptive controller separates fixed page latency from marginal record cost,
uses a bounded sample window, starts with 64 records, limits growth to 2x and
caps proof pages at 128 records and metadata pages at 1,000. A prolonged one-row
floor probes recovery. These bounds prevent the previous fixed-latency feedback
loop from permanently collapsing page size, without treating a slow proof page
as evidence that all later metadata is equally expensive.

## Canonical proof recovery

Assembled BEEF is checked before spending or broadcasting. An invalid root can
trigger bounded recovery through the configured chain tracker and active-chain
header/proof provider. A block hash alone does not establish canonicality.
Recovery validates the path, root, height, transaction identity and actual
80-byte header; it preserves transaction bytes and txid-only ancestry. Valid
BEEF takes the fast path without database proof lookups or graph copying.

At most eight proof lookups run concurrently, and SQL lookups use batches of at
most 250 distinct transaction IDs. Built-in stores atomically compare previous
proof authority fields before persisting a correction and invalidate prepared
BEEF in the same transaction. Delayed monitor responses cannot overwrite newer
proofs. Custom stores lacking compare-and-set support can repair the outgoing
BEEF without claiming that the shared proof record was persisted.

Unavailable canonical evidence produces `WERR_INVALID_MERKLE_ROOT` with its
existing public/JSON identity and retry guidance. Recovery does not fabricate
success or broadcast a transaction. Historical stores still need independent
operator auditing; an upstream fix is not evidence that every deployed record
was repaired.

## Timestamp boundaries and snapshot scope

The legacy timestamp/offset path preserves BRC-40's inclusive `since` boundary and existing entity order,
ID mapping, tombstones and merge rules. Records arriving later with the same
last timestamp must remain discoverable. Consequently, a large imported batch
sharing one timestamp can require a complete boundary reread even when it has
no changes. The benchmark deliberately tests this case. Advancing beyond that
boundary without a coherent source contract would lose valid peer changes.

A successful live merge is an eventual replica, not a point-in-time source
snapshot or authorization to activate a new primary. Existing BRC-38/BRC-39
export/import contracts are unchanged. Issue #544 remains open for coherent
remote snapshots, streamed archives and consumer adoption.

## Retained local SQL read views (unpublished candidate)

The 2.15 candidate adds `StorageKnex.openReadSnapshot({ lifetimeMs, signal })`.
Opening pins a SQLite or MySQL read view before returning. Its `read(callback)`
method reuses that transaction across idle periods; pass the supplied token to
**every** query and await every query before returning. Each provider admits one
retained view and each view admits one read at a time. Concurrent/nested reads
reject immediately. These local methods are excluded from the storage RPC
allowlist; the handle is neither an authenticated remote export nor a profile
boundary.

The lifetime defaults to five minutes, includes acquisition, and accepts integer
milliseconds from 1 through 3,600,000. Both monotonic and wall clocks enforce
expiry. Close, cancellation and expiry stop new reads and discard late results.
Await `close()` or `closed` to observe physical transaction/connection cleanup;
a read failure invalidates the view and rolls back. Configure database query and
connection deadlines separately: cancelling the view cannot interrupt a hung
driver call or user callback. Do not perform writes, peer/file I/O, progress
callbacks, or await `close()` inside a read callback.

A view occupies one pool connection until cleanup. With a one-connection pool,
other work must wait; the API does not create an independent writer. SQLite
concurrent-write qualification uses WAL and a separate connection. MySQL uses a
read-only repeatable-read transaction without changing pooled session defaults.
SQLite relies on the trusted callback's read-only contract. `StorageIdb` and
unsupported providers explicitly refuse retained views; their existing scoped
snapshot behavior is unchanged. Process exit loses the view.
The lifetime limits retention time, not the bytes accumulated in database WAL or
undo history while other writers continue; database storage limits remain separate.

The primitive itself does not provide a durable cursor,
remote handle, concurrent IndexedDB snapshot, or streaming archive. The local
sync integration below adds destination persistence and scheduling separately;
the retained-view primitive itself does not change legacy index order or wire bytes.

### Profile-bound local SQL pages

`StorageKnex.openWalletReadSnapshot(identityKey, { lifetimeMs, signal })` adds a
version-one typed paging interface over the same retained lifetime. Inspect
`supportsWalletReadSnapshot()` first; the base provider and IndexedDB explicitly
refuse it. The API and its capability are excluded from RPC. These are trusted
local database operations, not remote authentication or complete archive validation.

The returned source settings, user and all thirteen standard tables share one
view. No primary activation or managed-change policy is applied. Proofs include
those referenced only through the user's transaction requests. Deleted labels,
tags, mappings, baskets and certificates remain present. Inconsistent profile
ownership across mappings or certificate fields rejects the view rather than
silently omitting a relationship. Binary columns are `Uint8Array`, never expanded
number arrays; stored scripts remain stored values, without reconstruction.

```ts
const view = await storage.openWalletReadSnapshot(identityKey, { signal })
try {
  let cursor
  for (;;) {
    const page = await view.readPage('transactions', cursor, {
      maxRows: 128,
      maxBytes: 262144
    })
    await consumePackedRows(page.rows)
    if (page.done) break
    cursor = page.cursor
  }
} finally {
  await view.close()
}
```

Each cursor binds the view and table. Retrying the same position and limits
repeats a page. Process loss, cancellation, close or expiry invalidates that
position; a new view cannot accept it. It is not a durable destination checkpoint.
One read is allowed at a time and each provider retains only one SQL view.
The existing pool, query-deadline and lifetime limits above still apply.

Pages default to 128 rows and a 262,144-byte payload charge; limits are integer
values from 1 to 1,000 rows and 1 to 16,777,216 bytes. SQL first returns bounded
keys and cell lengths. The charge is twice each cell's stored byte length plus
64 bytes per cell. Only the prefix fitting both limits is fetched. A first row
over budget explicitly rejects, without loading or skipping that row. This
charge bounds stored page payload, not encoded wire size or measured process
RSS; callers must release consumed pages. Large-value streaming remains required
for records exceeding the maximum budget, and header/schema metadata is separate.

Traversal preserves the original unique-key order, including label/tag-first
mapping keys and field-name-first certificate keys, with each database's
collation. This order differs from canonical BRC-38 array order. The auxiliary
profile index below adds bounded profile range selection for eight direct tables
without altering any standard-table index, legacy OFFSET order or cursor bytes.
The separate numeric relation migration extends that selection to label and tag
maps. Certificate-field/global-table query work, commit-order incremental high-water
positions, IndexedDB retention and large-value streaming remain required by the
active program. The local sync integration below consumes these pages.

### Auxiliary profile indexes (unpublished candidate)

Migration `2026-10-01-003 add snapshot profile key indexes` adds
`snapshot_profile_keys` and `snapshot_profile_index_progress`. The first table
holds `(table, user, row)` keys for transactions, outputs, certificates, labels,
baskets, tags, commissions and sync states. Source-table insert, key/profile
update and delete triggers maintain the keys in the writer's transaction,
including writes from older binaries and independent connections. The standard
tables and indexes remain intact. These auxiliary tables are not wallet archive
content and do not change BRC-38, legacy sync or snapshot cursor encodings.

Use the normal provider migration entry point. This migration intentionally
uses `transaction: false`: MySQL DDL commits independently, and each bootstrap
batch commits its keys and progress together in a separate transaction on both
backends. A batch reads at most 256 source rows. SQLite takes its writer lock
before reading progress; MySQL locks the current progress and source rows until
commit. Triggers precede bootstrap, so independent profile moves, deletes and
inserts behind a committed cursor remain visible to resumed indexing. No
standard table is rebuilt and no wallet row is rewritten.

An interruption can leave auxiliary tables, triggers or committed bootstrap
batches before the migration journal entry. Retain them and retry the migration;
matching objects and committed positions are reused. Mismatched definitions or
malformed progress refuse completion. An abruptly terminated migrator may also
leave Knex's migration lock claimed. Before recovering that lock, independently
verify that its migrator has stopped and exclude every other migrator; this
implementation does not automatically break a migration lock. Keep a verified
backup and use the existing migration recovery procedure.

A retained reader chooses its mode from the exact migration journal entry and
complete progress in the same view as its header and pages. Missing journal
entries retain the previous traversal. A journaled but incomplete or mismatched
auxiliary schema refuses the new view. Existing views keep their original mode
across later migration or writer commits. Ordinary pages, archive pages and
archive closure checks share that choice; no private mode flag is added to
public metadata.

Drain snapshot readers and exclude concurrent migrators before rollback. The
migration's down operation validates owned objects, stops insert/update producers
before deleting their observers, then removes only the auxiliary tables and its
journal entry. Standard wallet rows and indexes remain unchanged. Older binaries
may read and write the unchanged standard schema while the forward migration's
triggers remain installed; binary downgrade procedures still apply to the
candidate's other migrations.

### Auxiliary numeric relation indexes (unpublished candidate)

Migration `2026-10-01-004 add snapshot relation key indexes` adds
`snapshot_relation_keys` and `snapshot_relation_index_progress` for
`tx_labels_map` and `output_tags_map`. Keys preserve label/tag-first composite
cursor order. Each key records the independent left and right ownership bases:
a mapping belongs to either parent's profile, including tombstones and inconsistent
cross-profile mappings. Such inconsistencies remain visible to the existing
page/closure refusal; the index must not filter them out and silently export less
data. Parent moves, key updates and physical deletion remove only the affected
ownership basis.

All removal observers across both relationship graphs are installed before any
producer. Bootstrap starts after the complete trigger set exists and commits at
most 256 mapping rows with its composite progress position. MySQL locks current
mapping rows and parent owners through commit. Trigger producers use current
locking reads even if their writer transaction has an older consistent read view.
SQLite uses its writer lock. Standard tables and their indexes are unchanged.
MySQL page queries explicitly select the auxiliary primary index: a maintenance
index can otherwise scan and sort an entire profile before applying the page limit.
The query also reads the recorded membership and fixes the join order and indexed
source lookup. A covering-index plan can otherwise scan the prior prefix before
InnoDB refreshes statistics, even when ordinary EXPLAIN reports a range.

The same migration-journal, retained-view, interrupted-migrator recovery and
reader-drain requirements described above apply. The migration has
`transaction: false`; preserve partial owned objects and committed progress, then
retry only after excluding another migrator. MySQL index DDL can stop between
table and index creation. Compatible missing indexes resume; mismatched table,
index or trigger definitions refuse adoption or removal. Down validates all
objects before removing producers, observers and auxiliary tables. Drain readers
before down; standard rows, legacy OFFSET order and portable/cursor bytes remain
unchanged. These auxiliary tables are excluded from BRC-38.

Repository fixtures compare all thirteen ordinary/archive tables and legacy
offsets before and after indexing, generate ownership/rekey schedules, and kill
the real migrator at seven DDL/bootstrap boundaries on SQLite and MySQL. The
native MySQL fixture observes independent locks under READ COMMITTED and
REPEATABLE READ and checks late-page native row-read counts with interleaved
profiles both before and after ANALYZE TABLE.
These are isolated synthetic fixtures, not deployed PXC or physical mobile
qualification. The following migrations cover certificate fields and global
proof requests/proofs. Source commit ordering, nonblocking IndexedDB, streaming
and staged restore remain required. Reader advertisement stays disabled and
#569 remains open.

### Auxiliary certificate-field indexes (unpublished candidate)

Migration `2026-10-01-005 add snapshot certificate field key indexes` adds
`snapshot_certificate_field_keys` and `snapshot_certificate_index_progress`.
Each field retains direct-user and parent-certificate membership independently,
including orphan fields and inconsistent ownership that the existing closure
checks must reject. Field/user/key changes, parent moves and physical deletion
update only the affected membership. Case-only and collation-equivalent renames
preserve the exact source field text.

The auxiliary text key preserves the source field's ordering. MySQL copies its
`varchar(100)` character set and collation and requires transactional InnoDB
source and auxiliary tables. SQLite verifies the source's complete ascending
unique key and built-in BINARY, NOCASE or RTRIM collation. A differently collated
secondary index cannot redefine the cursor. Unsupported or inconsistent schema
metadata refuses migration instead of silently changing source ordering.
Standard tables, indexes, legacy OFFSET order and BRC-38/cursor encodings are
unchanged. Auxiliary tables remain excluded from portable archives.

All removal observers precede producers. Bootstrap commits at most 256 source
fields and its text/composite position together; a separate started bit keeps an
empty field name valid. MySQL locks current source fields and parent ownership
through commit, including when an independent writer has an older consistent
read view. Parent maintenance uses the auxiliary certificate prefix and exact
source key rather than scanning all source fields.

The migration has `transaction: false` and resumes partial owned DDL and committed
bootstrap positions. The migration journal and complete progress must both exist
inside the retained read view before ordinary pages, archive pages or closure
checks adopt the index. Missing journal entries retain the previous path;
journaled incomplete state refuses opening. Exclude other migrators before
recovering a verified stopped migrator's lock. Drain retained readers before
down; validate owned objects, remove producers before observers, and preserve all
standard rows and indexes. Keep verified backups and the candidate's other
binary-downgrade restrictions.

The repository includes generated text/ownership schedules, independent MySQL
writer-lock checks, malformed metadata refusals and actual migration-process
termination at seven DDL/bootstrap boundaries on both databases. Native reader
fixtures measure first and late pages before and after optimizer statistics refresh. These
are synthetic source qualification fixtures, not deployed or physical mobile
acceptance. The following migration covers proof/request indexes; commit
ordering, nonblocking IndexedDB and the remaining sync/portability program
remain open.

### Auxiliary global proof/request indexes (unpublished candidate)

Migration `2026-10-01-006 add snapshot global reference indexes` adds four
auxiliary tables: `snapshot_global_edges`, `snapshot_global_keys`,
`snapshot_global_guards` and `snapshot_global_index_progress`. Requests belong
to profiles with a transaction whose txid matches the request. Proofs belong
through either a transaction's direct proof reference or a matching request's
proof reference. Multiple transactions and both reference bases retain separate
edges; removing one basis cannot remove another profile's remaining reference.
Missing proofs keep bounded presence metadata so later insertion or deletion
updates the same indexed selection. Unused proof guards are collected after the
last reference disappears.

Triggers serialize reference counts and proof presence in the writer's atomic
transaction. MySQL uses current locking reads, including an auxiliary lock for an
absent proof, so an older REPEATABLE READ snapshot cannot publish stale presence
or restore an obsolete request pointer. Removal observers precede producers.
Bootstrap locks at most 256 current transaction rows and commits their edges and
progress together. Retrying a committed batch does not increment reference counts
twice. Source txid comparison metadata must agree; source indexes, exact text,
standard rows, legacy OFFSET and portable/cursor encodings remain unchanged.

MySQL requires the standard unsigned key and matching text definitions on
transactional InnoDB tables. Custom CASCADE or SET NULL foreign-key actions are
refused before auxiliary DDL because InnoDB does not invoke affected child row
triggers for implicit cascades. Standard RESTRICT and NO ACTION definitions are
supported. SQLite verifies standard key/column definitions and complete txid
lookup indexes with matching BINARY, NOCASE or RTRIM order. Invalid legacy keys
or oversized text refuse bootstrap without publishing completion.

This is another explicit `transaction: false` migration. Preserve partial owned
DDL and committed positions, exclude other migrators, and recover a stale Knex
lock only after proving its migrator stopped. Ordinary and archive readers adopt
complete journal/progress state inside their pinned view; absent journals keep
legacy selection and incomplete journaled state refuses opening. MySQL pages
use the auxiliary `(table, user, present, row)` index and indexed source lookups,
including before statistics refresh. Drain readers before down; validate all
owned objects before stopping producers and removing auxiliary tables. These
auxiliary structures remain outside BRC-38.

Fixtures cover shared references, full-width unsigned IDs, source collations,
independent writer commits, retained ordinary/archive pages, bootstrap replay,
eight migrator process-loss boundaries, and first/late query plans and measured
row fetches. The pinned native launcher runs every archive/profile/relation/
certificate/global family sequentially with a 60-second child deadline per
group and verified owned-container cleanup. The global family is split into
complete process-loss, locking, schedule, seek and integration groups after its
combined local run consumed 51.6 seconds of the 60-second allowance. Every earlier
case remains mandatory. Complete exact-head qualification remains mandatory;
these synthetic fixtures do not establish deployed PXC or physical mobile
acceptance. Commit ordering, tombstones, primary reconciliation, nonblocking
IndexedDB, remote destinations, streaming/staged portability and full system
acceptance remain open. Reader advertisement stays disabled.

## Durable local SQL sync and ordinary backup

With the version-one migration applied, supported local SQL providers use these
pages for ordinary `syncFromReader`, `syncToWriter` and `updateBackups` calls.
`syncFromReaderResumable` and the additive `syncToWriterResumable(auth, writer,
options)` expose cancellation and page progress. Source reading and proof
preparation run outside manager ownership; only destination admission and each
atomic page commit enter the fair background queue. Foreground reads and writes
can proceed between those commits. Existing `progLog` callbacks receive each
committed page and the completion summary, including during serialized fallback;
their returned text remains part of the ordinary result log. Backup destinations,
entity dependencies, proof checks and 128-ID SQL batches run sequentially through
the lazy series coordinator. A failure stops before the next operation starts;
neither parallel database work nor an eager promise queue is introduced.
Primary reconciliation still uses its existing
exclusive path and remains required work in the full program.

The source gets a dedicated one-connection pool, preserving the original pool's
foreground capacity and telemetry configuration. SQLite requires a file-backed
WAL database. MySQL requires a static connection configuration with a database;
dynamic connection factories, externally shared pools and unsupported providers
retain the existing serialized path. Each provider admits one opening/live sync
source until physical cleanup completes. The default five-minute retention limit
includes opening; `snapshotLifetimeMs` accepts 1–3,600,000 milliseconds. Driver
query deadlines and WAL/undo disk limits remain separate.

Migration `2026-09-30-001 add durable snapshot sync` adds three auxiliary tables:
`snapshot_sync_sessions`, `snapshot_sync_ids` and
`snapshot_sync_primary_epochs`. A database trigger increments the primary epoch
on every primary change, including an independent writer changing away and back.
It does not change standard-table key order or legacy `sync_states.syncMap` JSON.
SQLite commits the migration atomically. MySQL's idempotent table, foreign-key
and trigger installation can resume after partially committed DDL. Apply
migrations using the normal provider migration entry point before enabling the
capability; merely opening storage does not upgrade its schema. MySQL migration
credentials need permission to create the auxiliary tables, foreign keys and
trigger; the ordinary runtime connection does not install them implicitly.

A session binds the wallet identity, source/destination storage identities,
network, source view, selected primary and its epoch. Rows, normalized ID mappings
and the destination cursor commit together. Source user metadata joins the first
page commit; cancellation before that commit leaves the selected primary intact.
Push and backup merge the source view's stored primary metadata using the existing
timestamp rule; they do not replace it with a manager's older cached selection.
Pull retains the destination manager's selection. Serialized fallback preserves
the same directional rules. This compatibility behavior does not refresh the
manager cache or implement primary reconciliation.
A prepared page is single-use and stale checkpoints reject. If an acknowledgement
is lost while the same source view remains alive, read the destination checkpoint
and resume it. When the source view is lost, open a new view and restart traversal
from the first table; committed mappings and entity merge semantics prevent
repeated inserts. Manager calls own and close their source view, so calling a
manager sync method again starts a replacement view. Advanced callers retaining
the same local capability handle can resume its acknowledged cursor. No source
cursor survives source process loss. Returned acknowledgements must match the
session bindings, next sequence, table position, completion flag and page cursor;
a mismatch rejects before another read or progress count is accepted.

One packed page is in flight. The resumable APIs default to at most 1,000 rows
and 262,144 charged bytes; configurable ceilings are 1,000 rows and 10,000,000
bytes. Ordinary push, pull and backup retain their 1,000-row/10,000,000-byte
ceilings; the adaptive controller may request smaller pages. Per-page mapping
work is limited to 4,096 distinct IDs, queried and persisted in batches of 128.
An oversized row, reference limit or retention expiry closes the source and uses
the established serialized fallback, preserving progress counts. Malformed rows,
profile/network mismatches, stale sessions and I/O failures reject. Fallback can
hold manager ownership for the remaining copy; bounded large-value streaming is
still required. The result/progress `mode` reports the selected behavior.

`snapshotCheckpoint` is separate from the legacy `checkpoint` field. It records
this destination's durable position, not transferable authorization. The local
`getSnapshotSync()` capability is excluded from RPC, and its types do not imply
an IndexedDB, remote or native adapter. The twelve replica tables preserve the
existing merge policy; original source sync-state history remains an archive
concern. BRC-38/39 bytes are unchanged.

For forward rollback, construct `StorageKnex` with `snapshotSync: false` on both
sides and retain the additive schema. Existing sync APIs then use their established
paths. Stop all new sessions before any binary downgrade; older migration code
may refuse a database containing newer journal entries, so disabling this feature
on a current binary is the supported operational rollback. Do not drop auxiliary
mapping/session state while work is active. No package is published or provider
upgraded by this source change.

## Next-stage remote design checkpoint (not implemented)

A future source-snapshot capability should negotiate a versioned contract
separately from ordinary sync and bounded transfer. A snapshot must bind the
authenticated wallet, network, storage identity, source schema, entity ordering
and immutable high-water position. Use a stable per-entity cursor (including a
tie-breaker) within that immutable view; do not reinterpret live timestamp/offset
checkpoints as coherent snapshots. The exact wire names remain subject to shared
conformance review and independent provider implementation.

Creation must establish the entire snapshot consistently, using a transactional
read view or immutable staging with an atomic manifest. Bound retained snapshots,
bytes, lifetime, per-identity concurrency and cleanup across replicas. A durable
resume token must bind the snapshot digest and cursor, reject another identity,
and fail explicitly after expiry. A restarted reader may resume the same
immutable snapshot or restart a new one; it must never combine both silently.

Streaming BRC-38 encoding should preserve canonical record order, binaries,
nullable history, source provenance and the standard's deliberate exclusions.
BRC-39 streaming must preserve the released envelope, KDF and authentication:
stage decrypted bytes privately, verify the complete authentication tag and
semantic relationships, then atomically activate an isolated import. Partial
plaintext is never active wallet data. Bound memory, worker/IPC queues, KDF work
and temporary disk independently; record crash recovery and safe cleanup.

Release gates for that next stage are old/new independent reader/writer vectors,
wrong password/identity/network and corruption cases, same-timestamp/tombstone
relationships, restart at every durable boundary, repeated import, native
browser/mobile evidence and wallet adoption. No partial archive or optimistic
activation should be labeled complete while those gates remain outstanding.

## Shared SQL snapshot staging (unpublished internal component)

The `2026-09-30-002 add snapshot archive staging` migration adds three auxiliary
SQL tables for the remote snapshot implementation in progress. It does not change
standard wallet tables, their indexes, legacy checkpoints or BRC-38/39 bytes.
Storage opening still does not run migrations implicitly. The tables do not enter
portable archives or ordinary synchronization.

`storage/snapshot/archive/KnexSnapshotArchiveStore` is an internal persistence
component, not an authenticated remote export API. A capture owns an internal
writer token and records one original source view, schema, network and wallet
profile. Each bounded page, sequence receipt and quota charge commits atomically.
An exact retry repeats the receipt; changed bytes or metadata reject. A completed
capture becomes immutable and readable from another server connection. The
capture controller must validate complete source closure before sealing it; this
store alone does not validate wallet records or cryptographic proofs.

The internal `captureKnexSnapshotArchive` controller now takes a dedicated SQL
reader and a separate staging connection. It reads original settings, the
profile and the migration version in one retained view; verifies every selected
foreign-key relationship against that profile; and captures all thirteen raw
standard tables through the shared keyset reader. Relationship checks return
only an invalid-row marker, without loading payloads or building full ID maps.
Pages use the existing binary transport frame. They are not canonical BRC-38
output, and this step does not authenticate transaction/proof contents.

The controller reads at most 128 rows and a 128 KiB conservative SQL payload
charge per page, then checks the encoded one-MiB limit before staging. It reports
acknowledged page/row/byte counts, releases the source view before sealing, and
discards staging after cancellation or a capture failure. If cleanup itself
fails, the reservation remains available for expiry/reaping recovery. Callers
must supply independent reader/staging pools and keep schema migrations outside
active capture windows. No RPC route or advertised capability is added.

The store's internal `directory` read returns bounded receipt metadata without
selecting payloads or returning writer credentials. It preserves the exact
original binding JSON bytes used to seed the hash chain. A replacement server
connection can read the same sealed directory; profile authorization and expiry
are checked again after loading its receipts.

`verifySnapshotArchiveDirectory` validates the expected profile, network,
original storage identity and optional resumed root/schema, exact metadata
fields, lifetime, row totals and the complete ordered receipt chain. All thirteen
table boundaries must be present. It returns detached receipts and a fixed-size
table index, so callers can verify arbitrary-table pages without downloading
earlier payloads. `verifySnapshotArchivePage` copies bounded typed bytes and
checks their digest and metadata against an already verified receipt. Returned
dates remain JavaScript Date objects: freezing their containing objects does not
freeze their internal time values. An eventual adapter must keep its verified
binding private and give callers fresh metadata copies.

The maximum accepted directory fits below a one-MiB metadata budget. Transport
integration must separately limit incoming envelope bytes before parsing. These
checks establish inclusion under the received root, not independent trust in the
source's data or proof semantics. The authenticated transport below consumes this directory; the remote row reader
and manager integration remain incomplete.

The internal creation-request store adds the separate
`2026-09-30-003 add snapshot archive requests` migration. A request ID hashes its
version, nonce, immutable absolute deadline and byte reservation. Admission checks
the database clock; the same expired request cannot reopen after its receipt has
been collected. The authenticated transport obtains fresh server time before a caller selects
that deadline.

Claiming a request reserves the existing shared handle/byte capacity before a
source pool opens. Archive assignment and the handoff from that pending charge
commit together; sealing and ready-receipt publication also share a transaction.
Lost acknowledgements recover the same ready archive. A process that loses an
incomplete source view cannot replace it under the same request. Terminal status
is separate from cleanup ownership: capacity stays occupied until pending charges
or staged pages are released exactly once. Retained receipts are limited to four
per profile and 64 globally, including terminal history; only expired, released
receipts can be collected. Close outstanding requests before removing this schema.

The request lifecycle is tested through actual SQLite transactions, independent
connections, interrupted assignment/publication and generated retry/cancel
schedules. Separate synchronous SQLite pools in one event loop can return
`SQLITE_BUSY`; tests drain both operations, check that exact refusal and retry
without double release. This does not qualify foreground latency or transparent
contention recovery.

The internal capture service now uses the provider's existing single owned reader
slot, shared with local sync. It tracks admission synchronously before any await,
claims SQL capacity before pool acquisition, and binds same-request retries to the
same completion or durable receipt. Capture and pool cleanup precede ready
publication. Explicit cancellation and service shutdown wait for owned cleanup;
shutdown fences new captures while completed archives remain available to a
replacement service. Failed physical cleanup fences the controller and retains
its reservation, including failure during source opening before a view is returned.
The source view lasts at most five minutes or the request's remaining lifetime;
the ready archive retains its original fixed deadline. This bounds process-local
reader ownership, not distributed physical pools through arbitrary process loss
or unbounded driver cleanup. The HTTP layer below exposes this controller; a
remote row reader and manager adoption remain separate work.

The initial policy allows at most eight handles and 128 MiB of logical reserved
storage globally, one handle and 32 MiB per profile, 1 MiB per page, 1,000 rows per
page and 4,096 pages. Metadata is at most 64 KiB. A reservation includes encoded
metadata/payload bytes plus fixed header and page charges; it is not a measured
bound on SQL file size, transaction logs, temporary disk or process RSS. The
shared database clock controls expiry (five minutes by default, at most one
hour). These preliminary limits do not establish acceptance for larger wallets;
operator resource policy and measured storage costs remain required work.

Partial, closing, expired or differently owned captures are unavailable to
readers. Cleanup first fences new writes, then deletes at most 32 exact page
keys per statement. The profile and global reservation remain occupied until all
pages are removed. Interrupted cleanup is resumable; concurrent closers release
capacity once. The current component requires its owning controller to invoke
cleanup/reaping. No unattended worker or public capability is installed by the
migration.

SQLite tests cover 300 generated staging schedules and 300 actual SQL capture/
cancellation schedules, independent hash-chain
receipts, cross-profile reads and cleanup, exact limits, and failures between page
insertion and checkpoint update. A synthetic process fixture terminates the
writer at five durable boundaries: before data, after page insertion, after the
checkpoint write, after transaction commit and after sealing but before the
acknowledgement. Uncommitted pages roll back; committed pages retain exact retry
receipts; only sealed captures are readable. Isolated MySQL 8.4.11 also exercises
1 MiB pages, independent connections racing for one profile, concurrent cleanup,
rollback and partial DDL recovery. Its controller fixture captures thirteen
tables over fourteen pages, retaining 140 original labels and primary metadata
while an independent writer updates both. It also verifies schema provenance,
packed binary and cross-profile relationship refusal. These results apply to
those fixtures. Deployed PXC, remote row/manager integration, canonical streaming,
complete portable semantic validation and the full #544 program remain open.

Run the synthetic process-termination fixture from the repository root on macOS
or Linux (Node 24 and the package build are required):

```sh
pnpm --filter @bsv/wallet-toolbox test:snapshot-archive-crash
```

The fixture owns a fresh temporary SQLite database per phase, kills only its own
child writer, checks recovery through a new connection, and removes those files.
It prints one result record per phase. This is a storage persistence check; its
synthetic pages are not a BRC-38 archive or a funded wallet recovery.

The MySQL fixture uses the local Docker Desktop `desktop-linux` context and the
already available MySQL image
`mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d`.
It creates a loopback-only disposable container with a 1 GiB memory limit, two
CPUs, 256 PIDs and a 512 MiB temporary data filesystem, then removes it. The
launcher neither pulls an image nor accepts an external database connection.

```sh
pnpm --filter @bsv/wallet-toolbox test:snapshot-archive-mysql
```

## Reproducible validation

The fixture uses 10,000 same-timestamp labels (including tombstones), 64 proofs
with 32 KiB transactions and associated wallet transactions. It compares
exclusive capability fallback with paged mode on native Chromium IndexedDB,
SQLite and authenticated HTTP-to-SQLite. The same source state is restored
between modes. It reports full-copy time, CPU/RSS or browser heap, SQL queries,
response body bytes, foreground percentiles, event-loop delays and page timings.
It also checks unchanged-boundary replay, incremental tombstones and a settled
unchanged copy. A 15 ms source delay tests fixed-overhead behavior.

```sh
pnpm --filter @bsv/wallet-toolbox bench:storage-sync
pnpm --filter @bsv/wallet-toolbox-client bench:sync
```

Native Chrome/Chromium is required (`CHROME_BIN` can select it). Emulator tests
remain useful for deterministic storage faults; fake IndexedDB timings do not
represent browser database performance. The acceptance fixture bounds full-copy
time, memory growth and foreground/event-loop p95, and requires foreground p95
to improve at least 2x without doubling full-copy time. Those are fixture gates,
not latency guarantees for every wallet, device or provider.

### September 23 local measurements

Measured sequentially on macOS arm64, Node 24.19.0 and pnpm 10.33.2, using the
256 KiB fixture above. The control is this branch's exclusive capability fallback;
it isolates scheduling behavior, not every change since the released package.
Foreground latency starts when its timer callback runs. Event-loop delay is
reported separately so synchronous CPU stalls remain visible. The exclusive
control has very few completed foreground samples because it holds the queue.

| Backend / mode                 | Full copy ms | Foreground samples | Foreground p50 / p95 / p99 ms | Event-loop p95 / p99 ms | Pages |
| ------------------------------ | -----------: | -----------------: | ----------------------------- | ----------------------- | ----: |
| Chromium IndexedDB / exclusive |       4027.1 |                  1 | 4021.50 / 4021.50 / 4021.50   | 1.30 / 1.60             |    45 |
| Chromium IndexedDB / paged     |       4110.0 |                384 | 0.90 / 25.90 / 132.60         | 1.30 / 1.70             |    45 |
| sqlite / exclusive             |       2368.7 |                  1 | 2342.43 / 2342.43 / 2342.43   | 85.12 / 106.86          |    45 |
| sqlite / paged                 |       2373.8 |                133 | 0.17 / 0.32 / 0.40            | 84.86 / 109.29          |    45 |
| http / exclusive               |      26184.7 |                  5 | 0.25 / 26092.86 / 26092.86    | 250.70 / 271.70         |    47 |
| http / paged                   |      26394.8 |                319 | 0.24 / 0.35 / 0.40            | 255.93 / 271.98         |    47 |

Native browser peak JS heap was 79.8 MB exclusive and 56.3 MB paged. SQLite
full-copy CPU was 1.86/1.86 seconds and sampled RSS growth 127.6/60.1 MB.
Authenticated HTTP CPU was 25.93/26.08 seconds, RSS growth 152.1/95.1 MB,
and response bodies 7,173,777/7,172,813 bytes. Values are exclusive/paged;
HTTP bytes exclude headers, requests and TLS framing. HTTP and SQLite include
source and destination in the same process. Absolute RSS includes the test
runner and previously allocated heap; sampled growth is not a total memory cap.

SQLite issued 31,612/31,876 SQL queries and HTTP issued 32,241/32,866, including
foreground operations. Extra queries reflect completed foreground work; this
change does not claim a database-query reduction. Paged maximum commit times
were 142 ms (browser), 104 ms (SQLite) and 81 ms (HTTP). Maximum measured paged
queue wait was 1 ms in the browser and 0 ms in the local SQL/HTTP fixtures.

All modes preserved the full same-timestamp boundary reread: 45 pages locally
and 47 over HTTP; a subsequent settled unchanged copy used two pages. The
network fixture remains CPU-heavy, with about 256 ms event-loop p95 despite
short queue waits. Moving crypto/serialization off the main thread is future
work; queue responsiveness must not be represented as eliminating that cost.
These are reproducible local observations, not cross-device performance promises.

Adjacent local spending benchmarks also pass: the pathological 178-source BEEF
plan used 17 queries and about 198 ms; the eight-source cold/prepared paths used
14 queries and about 7.3/5.8 ms. The funding, action-batch and legacy storage-sync
benchmark gates pass. Their existing external PXC cohorts require their governed
MySQL environment and were not executed by the default local invocation.

### September 24 review-update measurements

After integrating the SDK compatibility repair, repeat measurements with official
Node 24.18.0 and the same sequential fixture passed the acceptance gates:

| Backend                      | Full-copy ms, exclusive / paged | Foreground p95 ms, exclusive / paged | Paged event-loop p95 ms |
| ---------------------------- | ------------------------------: | -----------------------------------: | ----------------------: |
| Native Chromium IndexedDB    |                 3943.6 / 3971.1 |                      3938.80 / 24.50 |                    1.00 |
| SQLite                       |                 2270.1 / 2238.5 |                       2247.25 / 0.17 |                   82.23 |
| Authenticated HTTP to SQLite |               20982.5 / 21004.3 |                      20901.51 / 0.31 |                  195.69 |

These runs include shared reader/writer admission with unchanged authorization
ordering and direct entity normalization. Native peak heap was 79.8 MB exclusive
and 56.8 MB paged. Inclusive boundary replay and the two-page settled unchanged
copy remain intact. The same timing/sample limitations above apply; HTTP crypto
and serialization still contribute event-loop delay. Subsequent forwarding and
immutable-descriptor allocation refinements preserve the measured queue algorithm.

## Authenticated snapshot archive transport (unpublished candidate)

`StorageServer` now advertises a version-one `snapshotArchive` capability in its
runtime settings when the provider supports a dedicated static SQLite-WAL/MySQL
reader, the archive/request tables exist, and the configured envelopes can fit
the protocol. `snapshotSync: false` on the provider or `snapshotArchives: false`
on the server disables it. Persisted settings and ordinary RPC behavior remain
unchanged. Migration alone installs neither a listener nor a housekeeping worker.

Both full and mobile clients expose `getSnapshotArchiveTransport(identityKey)`
after authenticated negotiation; old, disabled or unsupported peers return no
transport. A client can also set `snapshotArchives: false`. This is a low-level
archive transport. Ordinary remote sync and portable export do not yet adopt it.
It does not supply a `WalletReadSnapshot`, a remote destination, canonical BRC-38
or independently validated transaction/proof semantics.

The transport obtains a fresh authenticated database-clock offer carrying the
source storage identity, chain and schema. `start` acknowledges durable admission
promptly; `status` polls the same exact deadline-bound request. A disconnected
caller retries that tuple, without extending its deadline or opening a second
source. A replacement server recovers completed receipts/directories/pages from
shared storage. An interrupted incomplete capture cannot resume as a new view
under the old request. `cancel` closes that request; a new capture needs a new ID.

Every method accepts exactly one versioned, profile-bound argument and rejects
extra ownership fields. The server binds the profile to BRC-103 authentication;
internal claim/writer tokens have no wire representation. The client retains its
shared authenticated server pin and separate storage-identity binding. Tagged
binary responses are mandatory. The dedicated AuthFetch caps response bytes at
2 MiB before framing/parsing, including the JSON-RPC envelope; maximum directory
and one-MiB-page fixtures fit that ceiling after HTML escaping and base64 encoding.
The server applies an additional 4-KiB request-envelope bound after its existing
bounded JSON parser. This is not a claim of a 4-KiB pre-parse allocation limit.

Creation reaps expired pending, partial, ready and legacy archives before claiming
new capacity. Explicit `resource-limited` terminal receipts distinguish a failed
capture budget from other failures, preserving the first terminal state through
cleanup. Future sync integration may consider serialized fallback before it has
exposed a source or begun a destination session; corruption, authentication,
network failures and mid-stream errors must still fail the active operation.

Server shutdown fences new captures synchronously and awaits both physical reader
cleanup and the HTTP close callback. A failed cleanup stays observable and keeps
its reservation. Temporary HTTP disconnection does not implicitly cancel an
accepted capture. Tests use real authenticated loopback HTTP with synthetic
SQLite profiles, both client variants, lost admission acknowledgements, server
replacement, profile isolation, rollback combinations, response limits and
shutdown during opening. These fixtures do not establish deployed performance,
physical mobile acceptance or completion of #544.

## Remote row reader (unadvertised implementation)

The client now implements a source-only `getSnapshotSync()` adapter that
negotiates the separate `snapshotArchiveReaderVersion: 1` setting when opened.
The server does not yet advertise that setting. Controlled HTTP fixtures opt in
to exercise the implementation; ordinary remote sync continues its existing path.
Old archive capability objects and legacy request/response shapes remain unchanged.
Legacy cancellation can report pending cleanup as an error; the explicit pending
receipt belongs only to the v2 reader.
The new adapter refuses destination operations and does not imply portable
export, staged restore or a remote destination implementation.

Reader offers retain bounded metadata without acquiring a source. An explicit
capacity refusal returns no request. An offered request uses version two and a
separate digest domain; admission requires that exact persisted offer and never
creates an absent request. Consequently cancellation can collect a successfully
released reader receipt immediately without allowing a delayed admission or the
legacy start method to recreate it. Failed and resource-limited receipts remain
observable until explicit cancellation or expiry. The existing four/profile,
64-total metadata limits and logical archive reservations are unchanged.

Only a native-fetch rejection permits one retry of an immutable admission,
status, directory, page or cancellation request. An offer is never retried;
recovery neither renews the lease nor starts another capture. Authentication,
framing and RPC failures do not select that retry.
Cancellation recognizes the local signal and the SDK's explicit cancellation
code; concurrent independent errors remain failures. The client uses one fixed
wall/monotonic lease, one operation at a time and one private decoded frame. It
checks the complete directory, receipt and row representation before returning
packed rows, fresh dates and an additive version-one `cursor.archivePosition`.
The position identifies the archive, frame sequence and consumed row offset; it
also checks the original row keys. Table lookup does not fetch earlier tables
or reinterpret SQL collation as JavaScript ordering.

Local destinations persist that optional position with the atomic row commit.
Preparation and progress callbacks receive detached cursor metadata, and an
acknowledgement with a missing or changed position is rejected. Legacy cursor
JSON is unchanged when the position is absent. The manager forwards cancellation
to source opening, returns committed progress only after successful cleanup and
does not switch to a different copy after an accepted remote source fails.

Actual loopback HTTP fixtures cover full/mobile negotiation, every archived
table, original-source retention through replacement, native-fetch loss before
and after immutable requests, failed authentication and cancellation. Both
clients also sync over HTTP into an occupied local destination: cancellation
retains the committed archive position, a later view completes without duplicate
labels, and the active destination and unrelated profile remain unchanged. The generated
reader property varies frame and caller-page boundaries over at least 300 cases.
These are implementation checks, not completed performance or platform evidence.
In particular, a cancellation handled by another replica can fence durable
admission and staging without proving that the original replica has physically
drained its SQL reader. Owner recovery and bounded driver/query cleanup remain
open requirements before server advertisement and program completion. No claim
of a distributed physical-pool ceiling follows from logical quota accounting.

## Durable source cleanup fence (unadvertised implementation)

The additive `2026-10-01-001 add snapshot archive source owners` migration
registers each service capture's exact internal claim in one of eight shared
slots before source-pool acquisition. The request and its archive remain charged
until the owning controller acknowledges awaited source and pool cleanup. Ready
publication requires that acknowledgement too. Another controller may cancel or
expire the request, but cannot free its pages, logical reservation or slot while
the owner record remains. Each append checks the durable request fence in the
same transaction as its page write. Direct archive close and expiry cleanup obey
the same owner fence; a pending source does not prevent cleanup of other archives.

A pending low-level close raises `SnapshotArchiveCleanupPendingError`; it does
not return successful cancellation. The v2 reader RPC carries an exact
`{ version: 1, outcome: 'cleanup-pending', requestId }` receipt. Only the existing
`true` acknowledgement proves completion. The higher reader validates that binding
and polls with one separate 30-second wall/monotonic cleanup allowance, at most 32
attempts, and delays of 100, 200, 400, 800 and then at most 1,000 ms. Each immutable
operation retains its existing single native-fetch-loss retry. Neither source
lifetime nor request identity is renewed. Exhaustion rejects with cleanup still
pending. The deadline aborts outstanding I/O and waits for its settlement; it does
not abandon that I/O through a racing promise. Transports must separately bound
operations that ignore cancellation. Independent errors retain their identity,
and a late valid completion acknowledgement still proves cleanup. A failed local cleanup fences that controller's
admission. Repeating an acknowledgement is idempotent and an old or incorrect
claim cannot release a successor. The owner migration refuses removal while
owners remain. Run migrations before admitting captures, keep all serving
binaries on the same candidate, and stop and drain captures before any downgrade.
Older draft binaries do not enforce this new table; mixed-version capture is
unsupported. Standard wallet tables and BRC-38/39 bytes are unchanged.

An elapsed lease is a fence, not proof that an old SQL operation stopped. The
backend guard implementation below permits recovery only after a separate proof
of source closure. The eight logical slots do not establish
a global physical-connection ceiling; per-provider physical admission remains
occupied until its acquisition and cleanup settle. Actual deployment replica and
driver limits require separate qualification. The generated two-connection
lifecycle suite exercises cancellation, repeated status/reaping, incorrect and
exact acknowledgements, and preserved reservations across at least 300 schedules.

Real full/mobile HTTP tests route cancellation through an independently connected
controller while the original source pool is held in physical destruction. They
observe pending receipts, retained quota and successful foreground writes, then
confirm cleanup before the opening cancellation settles. Generated pending and
lost-acknowledgement schedules preserve one signal, bounded attempts, independent
failure identity and released timers/listeners. Same-server MySQL evidence covers
the source-side fence and delayed pool destruction. These tests do not establish
PXC or a global physical-pool bound.

## Backend-bound owner recovery (unadvertised implementation)

Apply `2026-10-01-002 add snapshot archive source guards` through the normal
SQL migration entry point. It adds a guard version to owners and eight persistent
slot bindings. Existing owners default to version zero and are never inferred to
have a guard; they retain their reservation until explicit source cleanup.
New service captures bind their exact claim before opening a view and recheck
ownership, deadline and binding under the backend guard before reading wallet
data. Slot bindings survive release and reuse, preventing a delayed claimant
from choosing a new independent guard.

For file-backed `better-sqlite3` WAL, each slot uses one private guard database
beside the canonical wallet database, named `<database>.snapshot-owner-<slot>.sqlite`.
The binding records both files' device/inode identity and a persistent random
guard marker. The source holds a guard write lock on the same physical connection
as its wallet read view; foreground WAL writers remain independent. The private
pool closes the still-open transaction before acknowledging cleanup. An ordinary
commit or rollback would release the guard too early. A failed native close keeps
the guard and ownership pending rather than claiming drainage.

MySQL binds the actual server UUID, database and fixed slot to a named advisory
lock on the source connection. Its next transaction is read-only repeatable-read.
Physical cleanup waits for the native socket close event, not just mysql2's
earlier quit callback or the stream's `destroyed` flag. A different actual backend
refuses the binding. This is a same-server contract; load-balanced/PXC failover
requires separate qualification and cannot infer safety from a configured URL.

Admission and cancellation run one bounded recovery flight per provider, visiting
at most eight expired or terminal owners in sequence. A matching proof connection
must acquire the same guard, fence the exact claim under the shared capacity lock,
close physically and then acknowledge that owner. An occupied guard leaves cleanup
pending. A still-unbound claim can be fenced under the capacity lock before a late
binder enters. Independent backend and cleanup errors remain observable. Provider
and service shutdown await an already-started recovery flight.

An unproved native close keeps the provider's source slot fenced even after its
read promise settles. Further snapshot sources and recovery on that provider
refuse, and destruction preserves the cleanup error. An ordinary read failure
still permits a later source after physical cleanup succeeds. Keep the failed
owner reserved until backend recovery independently proves closure.

Run migrations before capture, keep candidate binaries uniform, and drain all
captures before downgrade. Guard files are persistent coordination state: do not
unlink, replace or recreate a bound file to clear a reservation. Missing files,
changed identities and changed markers refuse recovery. This implementation
qualifies stable local filesystems only; database relocation/restoration and
shared/distributed filesystems require an explicit binding-transition procedure
and separate evidence. Standard wallet tables and BRC-38/39 bytes are unchanged.

Synthetic tests cover eight simultaneous views, immutable reads with foreground
writes, cancellation/expiry, delayed acquisition and native closure, stale-owner
acknowledgements, missing/changed guard identity and cleanup failure. At least 300
generated guarded schedules exercise recovery and successor ownership. The
existing native crash and MySQL fixture commands also terminate an owned child
process, verify the reservation before loss and recover it afterward while
preserving foreground writes. These fixtures do not establish deployed limits,
distributed filesystems, PXC or physical mobile behavior. Reader advertisement
remains disabled pending complete lifecycle and program qualification.
