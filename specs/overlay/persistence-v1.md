# Overlay persistence contract v1

W02 persistence / S01; requirements S1, S2, S3, B2, B3 and X1. This is an
additive logical adapter contract and executable reference seam. It is not a
Mongo schema, a new public HTTP shape, or authorization for TS and Go writers to
share a node database. No production adapter implements this capability yet.

## Baseline and selection

At TS base `2bc799a8d8e535242e6de2d305f426ce3975ea7b`, `Engine.submit` broadcasts
and invokes its STEAK callback before persistence. Mutations and lookup callbacks
are separate operations; some errors are logged without rejecting the submission.
Knex transactions inside individual methods do not make that sequence atomic.
Go base `f5d8074be085c1970e113bc8ee55fecbab251fcf` likewise injects `engine.Storage`
and performs separate commit/lookup writes. Its GASP graph interface separates
append, validate, discard and finalize without a durable admission/cursor boundary.

TS `Storage.admission` optionally declares `overlay-admission-v1` and provides
`commitAdmission` and `reconcileAdmission`. `getAdmissionStorage` checks those
declarations only. Go uses a separate optional provider/interface, preserving its
existing `engine.Storage` implementers. Shape detection cannot certify durability.
The existing engines, SQL adapter, injected Go stores and default selections are
unchanged. Their existing STEAK callback must not be described as this receipt.
S03 integrates the TS Engine/Mongo capability behind an explicit adapter;
durable ACKs are not a production default. S04 owns the Go equivalent.

## Identity and exact values

Keys are tuples, never ambiguous concatenation: `(network, genesisHash, nodeId,
operationId)`. Topic, peer and job keys add their respective identities. Every
hash is 32 bytes represented as 64 lowercase hex characters. Content bytes are
binary; JSON fixtures use hex. New logical unsigned values are canonical decimal
strings `0|[1-9][0-9]*`, bounded by `18446744073709551615`. This includes satoshis,
scores, offsets, lengths, heights, output/block indices, epochs and lease tokens.
Existing numeric APIs/wire formats are unchanged. Adapters must impose the
additional transaction/protocol bounds and never round via a JavaScript number.
`parseStorageOutputIndex` validates canonical decimal uint32 (`0..4294967295`)
before producing an exact STEAK number; Go's `ParseStorageOutputIndex` returns
the equivalent `uint32`. The general uint64 parser must not replace this bound.

`admissionSemanticDigest` is SHA-256 of the following UTF-8 fields in order:

1. `overlay-admission-v1`, network, genesisHash, nodeId, verified raw txid, mode,
   contextDigest and decimal topic count;
2. each `(topic, policyId)`, sorted by topic's unsigned UTF-8 bytes.

Each field is framed as ASCII decimal UTF-8 byte length, `:`, then its bytes.
There is no separator between framed fields, no BOM and no Unicode normalization.
Reject empty fields, ill-formed Unicode, duplicate topics, invalid hashes and
unknown modes. The modes are `live` and `historical`; future engine adapters must
explicitly map their verification/replay policy. `contextDigest` binds off-chain
values and any other immutable admission-policy inputs; their caller-defined
canonical encoding belongs to the named policy. SHA-256 of empty bytes represents
an empty context. Changing those inputs or policy changes identity.

Proof variants, temporary read versions, scores and recalculated decisions do
not enter semantic identity. All raw txids must already be derived and verified.
A later valid proof cannot falsely conflict with an admitted raw transaction.
Matching retries return the original saved receipt; a separate validated proof
update remains required to persist better evidence. This slice does not implement
that update. Different operation IDs still cannot duplicate applied/outpoint keys.

## Atomic admission and observable outcome

An adapter validates the bounded plan before entering a transaction. It must
recompute the digest, bind scope/topics/txids and the saved STEAK to the decision,
check exact integer/range formats, and reject unsupported plan effects. Reads
include absent records and range/projection revisions: an untracked external read
cannot silently participate in optimistic admission. Recompute a stale topic
decision outside the transaction under the same logical operation identity.

One commit checks operation uniqueness/digest and all read predicates, both
history fences, conditional spends and payload readiness; applies outputs,
serving evictions, consumption edges and retained applied history; pins payloads;
persists history invalidation/handoff and outbox intents; and saves the exact
UTF-8 STEAK JSON plus its receipt. Existing applied/outpoint identities may be
reused only with equivalent effects, never overwritten by a competing operation.
Failure publishes none of these effects. Matching completed retry is checked
before stale reads or newer history fences and returns the saved receipt.

The receipt's `durability: atomic-local` covers only this local commit. Index
visibility is per target: only an enlisted index can be `visible`; external
indexes are `pending` until their checkpoint proves delivery. Propagation is
`pending` or `not-requested`, never delivered merely because admission committed.
Historical admissions have no propagation intents. Retry receipts preserve the
original observation even if delivery later advances; current delivery status is
a separate read. Pending/unknown results are not ACKs.

No verification, topic callback, network request, plug-in execution or payload
upload runs inside the database transaction. External projections require an
explicit `overlay-projection-v1` idempotent `applyEvent` plus rebuild/reconciliation
`reconcile` contract. Stable event IDs deduplicate repeats; checkpoints acknowledge
completed work. Both methods receive the storage scope explicitly; deduplication
and checkpoint identity include that scope, even when one projection serves
several nodes or networks. An ordinary lookup callback is unsupported for replay. Native
indexes may enlist only through an adapter-specific transaction mechanism.

## Retry and payload lifecycle

`TransientTransactionError` permits the complete body to run again only after the
previous attempt aborts, with reread/redecision where needed.
`UnknownTransactionCommitResult` retains the same opaque attempt/commit identity
and calls `reconcileAdmission(key, attemptId)` until committed or definitively
aborted. If the entire response was lost, `reconcileAdmission(key)` locates the
persisted unresolved attempt by operation key. Every repeated `commitAdmission`
must also recover that attempt before starting another body, including after a
restart. Missing operation/attempt data alone is not proof of abort; an unknown
attempt remains pending, and a known conflicting digest is rejected. A reconciliation
error remains unresolved; no fresh body, plugin replay or successful ACK follows
from a timeout. Adapter exceptions are storage/transport failures, distinct from
the bounded semantic rejection codes. Telemetry uses codes and counts, never raw
payloads, credentials, policy input or unredacted connection errors.

Payload references carry kind, digest and exact length. A manifest refers to
shared per-transaction/proof components so overlapping BEEF ancestry is shared.
Output scripts can use ranges of published payloads, including a raw transaction
larger than a BSON document. Stage/upload/verify/publish bytes outside admission;
the short commit references only `ready` metadata and atomically pins it. GC's
`ready -> deleting` claim must serialize with every pin/reference creator and
forbid new references after the claim. Physical cleanup is recoverable separately.
This slice implements no upload, GridFS, collection, migration or garbage collector.

## Recovery and publication

`chainEpoch` advances on reorg. `topicHistoryGeneration` advances on a change to
historical admissions, including the same height and block hash. Immutable anchor
revisions retain both dimensions; current pointers require both and the pinned
canonical header. History updates invalidate affected anchors and downstream
comparisons before a current tip or green status can be reused. Serving bans,
spent outputs and index eviction do not remove canonical admission evidence.

An admission that changes history supplies `historyUpdate`. Its next generation
must exceed the expected one without changing chainEpoch. If its own recovery
worker caused the revision, the same transaction checks the job's current scope,
topic, peer, job ID, both generations, unexpired database-time lease and token,
then moves that checkpoint/lease to the new history generation. Competing changes
rewind affected work. `isRecoveryLeaseCurrent` is a pure predicate to evaluate
inside that CAS; evaluating it before a write does not establish fencing.

`canAdvanceGaspCursor` only gates proposed cursor publication. Durable graph
finalization/admission and advancement must share the transaction. A tuple is
usable only after negotiated wire support. Inclusive numeric-since requires
proven inclusive semantics and complete equal-score drain. Otherwise use a proven
completed no-skip full resync or return capability-limited with no advancement.
A finite page, strict-since peer or unknown semantics never proves ties drained.
These helpers do not change existing peers or implement the S06 scheduler.

## Evidence and continuation

[`fixtures/persistence-v1.json`](fixtures/persistence-v1.json) contains independent
Python hashlib expectations for UTF-8 framed identity, exact integers, cursor
conditions and lease/revision fences. TS and Go consume byte-identical copies.
The test-only admission harness exercises saved ACK replay, conflicts, atomic
reference publication and pending/reconciliation outcomes; future adapters can
run the same behavioral scenarios. An in-memory model passing them does not
establish crash durability, Mongo transaction retries or managed-service recovery.

S02 owns database payload/schema/retry implementation; S03/S04 own engine commit
integration; S05 owns projection workers; S06 owns graph cursor negotiation and
finalization; B02/B04 own durable anchor/job/comparison storage and recovery.
Replica-set crashes, unknown commit labels, index enlistment, payload GC races,
all-equal-score peer exchange and deployment/migration evidence remain required.
No consumer migration is required for this additive S01 API. Mixed-version
concurrent TS/Go writers remain unsupported.
