# Candidate snapshot content receipts

This unpublished #569 component adds content comparison to the full, client and
mobile snapshot adapters. It does not establish complete #544 delivery or
production readiness. The separate journal DATA path is described in [journal-artifact-transport.md](journal-artifact-transport.md).
Large-payload and remote primary integration plus full-system qualification remain required.

The full, browser and mobile package entries export the type-only
`SnapshotSyncContentPosition`, `SnapshotSyncContentRevision` and
`SnapshotSyncContentReceipt` names. The declaration-consumer example in
`test/consumer/snapshotSyncContent.ts` reads from an actual retained source and
distinguishes the previous-copy receipt from a new copy acknowledgement.

## Actual source and comparison DATA

A journal source may expose `WalletReadSnapshot.readContentRevision`. It reads
from its actual pinned transaction and repeats the source, schema, receipt,
profile, primary and lifetime checks. Public header or receipt copies cannot
change that transaction's metadata. A preliminary observation opens and
physically closes its own source before returning DATA; a later copy captures
its own revision. The preliminary value is never an ACK for that later copy.

The bounded revision contains version, binding, content and metadata SHA-256
values, plus exact signed-64 decimal floor/high-water positions. Fifteen indexed
metadata seeks cover all thirteen scope and two global streams, including
retained tombstones. Capture-only clock reservations do not change content.
The retention floor is part of the fingerprint, so pruning cannot silently
restore an old fingerprint. Metadata binds the actual storage/profile, dates,
network and primary epoch.

A source can return `unchangedSince` only after finding no event above the
previous position in retained same-binding, same-metadata history. A lost
history interval or new event declines that confirmation. A future position
refuses. Positions and digests grant no backend ownership, source lease,
primary selection or authorization.

## Atomic destination completion

The forward SQLite/MySQL migration
`2026-10-17-001 add snapshot content receipts` adds only
`snapshot_sync_content_receipts`. The original wallet data, version-one
session, ID-map and primary-epoch schemas remain. Postgres records the same
explicit no-op contract as the other snapshot auxiliary migrations.

BEGIN stages pending source DATA in the original session writer. The final
ordinary row or native field writer prepares a one-use completion operation
before effects, then stamps the post-data destination state after that same
writer advances the original checkpoint. A transaction end, second use,
changed session/profile/primary/schema/root or completion failure cannot issue
a completed receipt. A failure rolls back with the original final-page ACK.
A previously completed legacy copy cannot acquire a retroactive stamp.

Comparison reuses the prior durable ACK only after fresh source and destination
confirmation in the actual destination writer. Both confirmations may advance
retained DATA positions; neither renews the previous physical source. Local
manager admission and generation checks still fence the operation. Remote
confirmation dispatch releases manager admission during HTTP, and the server
owns the current SQL session and primary checks.

MySQL comparison uses the existing exclusive NOWAIT clock barrier so a position
cannot jump over an allocated but uncommitted event. Optional completion DATA
abstains on the exact non-aborting lock refusal or a physically verified disabled
event window; it never pretends to have confirmed the copy. Other errors retain
their normal rollback channel. SQLite reads after the original writer reservation.

Receipt rows are scoped by user plus a SHA-256 lookup of the exact opaque source
identity, retaining its original spelling as a residual check. SQL collation
cannot collapse case or trailing spaces. Reads bound every text cell before
parsing. User deletion cascades only its auxiliary receipts.

These receipts are discardable derived DATA, like archive staging. They are not
financial `internalize_receipts`, source authority or part of the existing
48-family native baseline. A composed/restored wallet can start with an empty
comparison cache and copy normally. Fresh private SQLite runs the exact public
installer callback through its original owned transaction; native executable
pins, dispatch coordinates, financial families and resource limits stay unchanged.

## Remote compatibility

The original exact `snapshotSyncDestination` advertisement and version-one wire
remain. The separate `snapshotSyncContent` advertisement negotiates bounded
observation, completed-receipt lookup/confirmation and content-aware BEGIN.
Authentication, network/profile binding, eight-operation/source-scope quotas,
30-second I/O bounds and existing frame limits still apply.

A new remote reader explicitly requests content archive admission. Its
version-two binding includes the revision captured from the actual journal
view; the exact binding JSON enters the existing archive digest. Altering that
revision fails directory verification before destination admission. The source
holds the existing archive guard on the actual journal reader connection until
physical close. Cross-replica cancellation cannot release its quota before that
connection closes. The remote archive remains an actual immutable, leased row
source; its bound revision is DATA, not a reconstructed SQL source actor.

Old readers request the original archive binding. Old peers omit the content
advertisement and retain their original BEGIN, row path and checkpoints. A
partial or changed installed schema is an error. Providers without the new
capability keep their compatible path. Packed IndexedDB implements the optional
content contract through its actual MVCC owner, as described below.

On a confirmed unchanged copy, `SyncSessionResult.noChangeReceipt` names the
previous durable checkpoint and fresh observed source DATA. It reports zero
copied pages/inserts/updates and does not manufacture a new snapshot checkpoint.
Progress receives a separate checkpoint copy; observer failures still propagate.

## Packed IndexedDB

The actual packed connection supplies a monotone wallet-data revision and a
physical epoch. The content digest has a distinct MVCC domain; it does not
pretend that this backend has SQL's fifteen metadata streams. Binding includes
the actual namespace/version, epoch, profile, storage and network. A global
revision can conservatively decline reuse after another profile writes, while
keeping that profile's rows and payloads separate. Normal writes remain routed
through the original observing connection factory.

A retained source derives DATA from its actual captured revision and private
metadata, repeating its current owner/schema/profile/lease checks. Observation
closes that real lease before returning; it does not enumerate every source
row. A new full copy still runs the original complete closure validation.
Matching future positions refuse. Genuine cross-realm Date metadata keeps its
exact value through a built-in Date brand check; impostor getters do not run.

The existing charged flat sync-session record gains one optional canonical JSON
field, bounded to 2,048 characters. BEGIN and the final actual wallet/maps/ACK
writer own pending and completed DATA. No object store, database version,
existing metadata validation or physical/working budget changes. Old code can
ignore/preserve the optional field, or omit it when starting a new session;
completed legacy sessions cannot acquire retroactive comparison stamps. Reopen,
source/destination changes and primary invalidation retain the same boundaries.
The new case is registered alongside every original genuine browser case;
emulated edit feedback alone does not qualify browser/device behavior.

## Cancellation

A remote observation keeps its original bounded in-flight HTTP operation until
the source-close reply drains. Caller cancellation is requested immediately and
acknowledged after that operation; it does not abort HTTP early and infer remote
physical cleanup. The existing 30-second I/O deadline remains separate from the
cancellation bound. Malformed replies, schema failures and physical cleanup
errors keep their error channel. A held-reply regression also performs genuine
foreground SQL while cancellation waits.

## Rollback and qualification

Dropping the verified auxiliary receipt table removes comparison cache DATA and
makes subsequent copies use the compatible path. It does not roll back wallet
merges or their original durable ACKs. The down migration refuses a changed or
foreign same-name table. No automatic destructive migration or publication is
part of this candidate.

Focused ordinary SQLite regressions cover same-view metadata, capture-only
clocks, signed-64 positions, bounded covering-index plans, rollback after final
data, stale destination/primary state, legacy refusal, both remote directions,
old/new negotiation, archive tampering and physical cross-replica cancellation.
Host results are advisory; matching Linux/native/MySQL, browser/mobile,
performance, released-consumer, security/mutation and exact-head CI/review
qualification still apply to the complete implementation.

Native snapshot schema admission recognizes each optional receipt table only after exact current table and implicit-index validation, with no extra triggers, indexes or temporary shadows. Older profiles may omit either table. Unexpected objects under the snapshot-sync prefix and changes to the primary trigger still refuse in the original actual transaction; no schema verdict is cached. Ordinary bounded user/role reads quote column names and aliases through Knex identifier bindings so PostgreSQL preserves camel-case metadata. Snapshot capabilities remain unavailable on PostgreSQL.

Provider destruction drains an operation rejected before maintenance configuration without treating that exact allocation-free refusal as a native cleanup failure. The original refusal remains observable to the operation; independent and aggregated cleanup failures still reject destruction. Journal provenance upgrades retain the configured migration journal name. Ordinary handoff-schema rollback stays forward-only; the existing explicit full-wallet `dropAllData` path alone removes its verified control tables and triggers after source owners drain. This is data erasure, never a downgrade or a way to retain a writable unenrolled wallet.

PostgreSQL records the handoff migration as a no-op, so an absent handoff table retains legacy DATA sync even when that journal entry exists. An actual present or previously observed control table still requires full verification; a dialect label cannot downgrade an enrolled profile.
