# Primary write fences

The unpublished candidate adds an internal operation fence for ordinary Knex
`createAction`, `processAction`, `internalizeAction`, abort, action-batch SQL phases, BRC-177
expiry setup/arming, certificate insertion/relinquishment and output relinquishment. It reads the actual authenticated user, database storage
identity, network and database-owned `snapshot_sync_primary_epochs` value before
asynchronous preparation. It retains comparison values only, with no SQL
transaction, connection or global manager writer during preparation.

Each participating SQL commit takes the actual user/epoch locks before its read
view (or SQLite's real writer reservation), checks the current role and exact
installed ABA trigger, performs the bounded SQL work, and rechecks before commit.
A primary change away and back still rejects an old operation. Role changes made
inside that writer roll back the complete transaction. Only a live transaction
issued by that same captured operation can be nested; copied or escaped tokens
do not establish ownership. The fence creates no source actor, primary grant,
financial acknowledgement or new operational sync state from DATA.

`createAction` shares the original epoch through funding/output writes, known
input claims and failure cleanup. Proof preparation remains outside SQL writers.
An obsolete request cannot perform cleanup against a later primary generation.
`internalizeAction` carries the same epoch through its own financial/ownership
commits, including post-network recipient publication and rollback of spent-input
transitions. Its durable receipt claim remains a separate actual ownership check.
Certificate and output relinquishment use the same operation boundary.

Abort captures before its chain-status lookup. Batch begin/extension, renewal,
resume, manifest persistence, packed/blob uploads and abort use the same
original-epoch SQL boundary. Digest-based commit passes its original capture
through the commit helper; completed-result persistence after network work is
fenced too. Expiry pre-funding and activation pass the original capture through
createAction rather than recapturing after height/anchor preparation. Arming
captures before signature/height work and rechecks inside its final CAS writer.

`processAction` captures before signed-transaction preparation, fences its actual
request/output/transaction persistence, and forwards that same capture through
broadcast scheduling and return. Batch completion and internalization pass their
original captures through the shared helper too.

Shared broadcasts capture participating profiles from actual transaction/user
rows before proof repair or external posting. Each profile's financial statuses
and positively confirmed stale inputs use its own original fence and recheck
actual row ownership. One obsolete profile does not block still-current monitor
peers. An authenticated initiator cannot borrow another profile's capture to
persist its request result. Ready requests must belong to the authenticated
initiator through real transaction rows before scheduling or posting; notification
JSON cannot supply that ownership. A profile inactive at capture cannot acquire write
permission merely by becoming active before the reply. No SQL transaction spans
broadcast, chain or UTXO observation. An actual orphan may receive cache-only
request maintenance; it supplies no financial owner or synthetic identity.

Shared request history is refreshed under a writable row lock, preserving late
notes and notification identities instead of overwriting them from the preflight
snapshot. MySQL/PostgreSQL writable exact-request lookups use current locked
reads; retained read snapshots keep their query-only behavior. Financial fan-out
uses the captured real transaction rows, not IDs supplied by notification JSON;
new copies and moved profiles remain for a fresh reconciliation pass. Completed
proofs are never downgraded, and failed financial rows still require the distinct
proof recovery path. Existing serialized adapters without the additive captured
entry point retain their original behavior. Caller-supplied transaction overloads
retain their legacy contract; the new first-party network path passes no SQL
token to transport.

Mined-proof completion now carries the original participating profile captures
through per-profile notification and failed-transaction recovery. UTXO output
observations precede SQL writers; an obsolete profile's recovery rolls back and
is omitted from committed recovery logs, while current peers proceed. The request
remains unnotified until every actual financial copy has the selected proof.
Late copies stay visible for fresh reconciliation. An obsolete operation cannot
reuse a capture with a different provider. The authenticated proof endpoint
captures before proof validation; the proof checker and SSE mined-proof producer
capture before external proof observation. Unfail also captures before its proof
fetch and keeps the exact-request authenticated-proof custody check. Old
serialized adapters retain their existing dispatch and malformed-proof errors.

These checks are restrictions on real SQL operations. `AuthId.isActive` supplied
by a caller does not grant permission; user ID and identity must match the actual
current row. Another profile's role change does not revoke this profile's write.
The source/target sync/import paths keep their separate actual writer admission
and financial semantics; they do not use an ordinary primary write fence to
pretend that an import activates a restored primary.

## Monitor scheduling and replay

Supported SQL captures advertise internal `prepareOutsideManager` scheduling.
The actual provider must still compare its original role/epoch in every writer;
this routing hint is not SQL permission and cannot be selected by wire DATA.
Proof checking, unfail, waiting sends and mined-SSE recovery release manager
ownership before external work. Each actual SQL callback rejoins the original
manager/provider as background work, allowing queued foreground work to run
first. Provider replacement rejects old callbacks. Older/custom providers keep
the serialized path unless they implement the actual fencing capability.

Proof-checker metadata merges into current locked rows. Concurrent attempts,
rebroadcast cycles, late history/notifications and advanced durable states survive
slow observations. Request objects publish new metadata only after commit and
its final epoch check. Entirely invalid broadcast sets return validation results
without posting an empty transaction list.

SSE and proactive terminal reconciliation capture before observations and apply
failure bookkeeping plus input quarantine atomically for each real profile.
Inactive/moved profiles defer without granting another profile authority or
blocking unrelated requests. Their original durable states stay pending for a
fresh current-primary invocation; deferral is not a financial acknowledgement.

SQL drift repair now scans metadata with user/transaction keysets and performs
one financial transaction's bounded repair per actual epoch-checked writer.
Completed-proof retry hydrates one request at a time behind bounded ID pages.
External proof/output observations stay outside manager and SQL ownership;
only commits rejoin background admission. Stored proof completion is not
replaced by a weaker rejection. Deferred terminal and accepted states are
replayed for a profile only after fresh actual primary admission. Recorded
conflict/stale-outpoint evidence is applied in the same writer as input release;
failed-parent evidence is checked against current parent state. Reclaim-anchor
protection and original legacy failure/blocked-request behavior remain.

Abandoned-action cleanup captures each actual profile before queuing its first
commit and keeps that capture for the scan. Every bounded background writer
re-reads ownership, status and age; a fresh action or obsolete epoch is retained,
and skipped rows contribute to the mutation-safe page offset. Only committed
failures are logged. Expired batch cleanup also retains original actual profile
captures and rechecks the locked expiry state. It never frees an inactive
profile's reservations, manifest or blobs and counts only committed releases.

UTXO release captures the actual user role before script or provider work and
rechecks the exact outpoint, amount, basket and reservation state inside the
original writer. Read-only review remains available on inactive profiles. Both
full atomic and bounded conclusive monitor entry points release manager ownership
for provider calls; physical commits rejoin background admission and reject a
replaced provider. Existing candidate/provider/timeout and unknown-result limits
remain. The internal optional admission callback only schedules SQL; it is not
wire data or a primary grant. The change-parameter spec-op also uses the actual
original user writer.

Double-spend review captures actual participating profiles before each network
observation and refreshes current locked request metadata before marking it for
proof recovery. A late proof, newer record, durable input conflict or obsolete
profile is retained for fresh reconciliation. Only committed `unfail` changes
are reported. This cache state never substitutes for validated financial proof
recovery. Older providers retain the original serialized/batched path.

Expiry lifecycle captures each page's actual profiles before height/status/UTXO
observations. Cancellation, observed-target metadata, revocation/conflict CAS,
reclaim activation, retry and proof-winner finalization all use the original
actual writer. Supported monitor preparation releases manager ownership and
physical SQL rejoins background admission. Primary retirement/ABA defers without
counting a financial result. Reclaim activation rechecks the current target and
actual anchor custody before claiming it. Posting carries the original actor and
pre-observation peer captures; after activation, only that actor's committed
row IDs for a predeclared signed txid may be refreshed under its original epoch.
No newly appearing peer or new primary role is captured after I/O.

Expired batch candidates use 100-row SQL keysets and only lease metadata; each
writer rechecks current expiry without hydrating manifests, results or blobs.
Background cleanup releases manager ownership between actual commits. Providers
whose SQL reservation predicates already honor logical expiry skip global
physical cleanup in foreground batch begin/extend/resume. Older/custom providers
retain their original physical-cleanup requirement and serialized scan. These
changes preserve expiry/reclaim financial semantics and original resource gates.

## Migration and compatibility

No new schema, wire field, native ABI, quota or persisted authority is added.
Supported migrated SQLite/MySQL stores use their existing durable epoch table
and exact trigger. Partial or changed installation fails closed. A supported
older store without that migration, an explicitly disabled snapshot capability,
or a custom provider retains the existing serialized fallback. The internal
transaction callback is additive and cannot be selected by wire data. PostgreSQL
and IndexedDB retain their current behavior until their own implementation is
completed and qualified; this change does not advertise a new capability there.

## Remaining integration and validation

The role transition itself must still demote/fence the old primary before a new
primary becomes writable, with durable recovery for an uncertain remote reply.
These ordinary writer restrictions do not implement that distributed handoff.
The [durable handoff controls](primary-handoff.md) now connect source preparation,
target parking, retirement, actual final receipt/postimage-gated activation and
explicit backup propagation to local and authenticated full/mobile manager
selection. Incoming DATA and ordinary writes retain actual enrolled-role checks;
uncertain replies recover forward. Complete provider, financial, platform and
exact-head qualification remains required before production adoption.
