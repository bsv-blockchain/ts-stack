# Overlay Mongo foundation v1

## Status and boundary

This is an additive, opt-in MongoDB storage foundation for `@bsv/overlay`.
It supplies schema bootstrap, scoped keys, content-addressed payload primitives,
and durable read-guard primitives. It does **not** select MongoDB by default,
connect MongoDB to `Engine`, implement `AdmissionStorage`, or make an admission
receipt claim. The existing Engine, Knex, and injected-storage paths retain
their current behavior.

MongoDB is an optional peer dependency. An application that imports a Mongo
entry point must install a compatible driver explicitly:

```sh
npm install @bsv/overlay mongodb@^7.5.0
```

The root package entry deliberately does not load the driver. Mongo consumers
use the exported deep modules, for example
`@bsv/overlay/storage/mongo/MongoSchema` and
`@bsv/overlay/storage/mongo/MongoPayloadStore`. A packed-consumer check must
cover those exact ESM and CommonJS imports as well as a root import without the
optional peer installed.

## Deployment and schema

`bootstrapMongoOverlay` creates or verifies only Overlay-owned collections,
including the `overlayPayloads` GridFS files and chunks collections. It
refuses incompatible validators, indexes, schema fingerprints, a sharded
deployment, and a non-primary bootstrap connection; it never drops, migrates,
or relaxes existing records. Bootstrap also makes a majority+journaled
transaction probe.

The supported operating profile is a dedicated, unsharded three-member replica
set for an Overlay deployment. The bootstrap check establishes that the server
is a writable replica-set primary; operators remain responsible for ensuring
the three-member topology, TLS, authentication, backups, and capacity. MongoDB
transactions require a replica set or sharded cluster, and transaction runtime
and resource limits still apply. See MongoDB's [transaction production
considerations](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/).

Every Overlay-owned row has a schema version and bounded identity parts.
Chain-wide records include `network` and `genesisHash`; node-owned records add
`nodeId`. Record identifiers use an unambiguous framed encoding, rather than a
delimiter-joined string. Exact wire integers are canonical decimal strings:
the schema helpers reject non-canonical values and preserve uint64 values
without passing them through an unsafe JavaScript number. Output indices have
the stricter uint32 range. Collection validators and indexes bound row shape,
field length, array size, receipt size, and indexed identity fields so an
unbounded owner record is not silently created. MongoDB's BSON document ceiling
is 16 MiB; schema bounds remain necessary even below that ceiling. See
[MongoDB limits](https://www.mongodb.com/docs/manual/reference/limits/#bson-documents).

## Payload publication, references, and collection

`MongoPayloadStore` stores content by chain scope, kind, and SHA-256 digest.
It validates canonical declared length, digest, raw-transaction identity where
provided, and configured application bounds before publishing. Small content is
kept inline under a conservative ceiling. Larger content follows this sequence:

1. Reserve a fenced `uploading` payload row. Reservation lease comparisons use
   Mongo server time.
2. Stream bytes to a GridFS file marked `staged`, then verify the observed
   length and digest.
3. Mark that physical GridFS file `published` with its owner and fencing-token
   metadata.
4. Compare-and-set the small payload row to `ready`. Only a ready row can be
   referenced.

This order is intentional: GridFS cannot participate in multi-document
transactions, so a transaction must only pin already-published content. See
the MongoDB [GridFS documentation](https://www.mongodb.com/docs/manual/core/gridfs/).
The store's recovery operation can either finish a verifiable expired upload or
retire only the fenced owner's incomplete file; it does not assume that an
unexplained owner record is disposable.

Reference creation is a caller-session operation. It conditionally updates the
same `ready` payload row before inserting the reference; a prior snapshot read
is not accepted as the guard. Garbage collection counts live references and
claims `ready` to `deleting` in the caller transaction. Once the claim is
visible, a new reference cannot pass the same-row `ready` guard. Physical
GridFS deletion and `deleted` finalization resume separately and are safe to
retry after a process failure. Pins are references and are the only reference
kind allowed to expire.

Payload and reference operations accept bounded timeout and cancellation
controls where they operate in a caller's admission body. Neither payload
publication nor collection runs verifier logic, network activity, uploads, or
plugin callbacks inside an admission transaction.

## Admission transaction integration is pending

The foundation is deliberately smaller than the v1 admission contract. A later
Engine/adapter integration must compose the guarded payload primitives with the
whole admission operation in one short transaction. Until that integration and
its conformance evidence land, no Mongo method is an `AdmissionStorage`
implementation and no saved STEAK/receipt is exposed as a durable admission
acknowledgment.

The pending transaction core must use a finite retry budget and distinguish
MongoDB's labels on the **same session and operation identity**: rerun a
`TransientTransactionError` body only under that identity, and reconcile an
`UnknownTransactionCommitResult` before a new body may run. Its completion
record must be majority+journal persisted with the exact receipt. Expired
orphan cleanup must use a compare-and-set proof rather than treating absence or
an ambiguous commit as an abort. MongoDB documents the retry-label behavior in
its [transaction API guidance](https://www.mongodb.com/docs/manual/core/transactions-in-applications/).

That integration must keep external indexes and propagation asynchronous:
persist an idempotent outbox intent in the admission transaction, then let a
leased worker deliver it. A callback may participate only after it declares
replay safety, reconciliation, cancellation, and bounded work. It must never
be invoked in the Mongo admission transaction.

## Compatibility and operations

There is no SQL-to-Mongo migration, dual-write mode, shared concurrent-writer
topology, or default-adapter switch in this foundation. Do not point existing
SQL and Mongo writers at the same logical Overlay authority. Operators should
run Mongo bootstrap and packed-consumer verification before an explicit future
adapter activation; that activation will need its own versioned migration and
recovery plan.
