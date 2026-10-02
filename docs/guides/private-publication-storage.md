# Native private publication storage

This branch contains an internal Node reference foundation for BRC-195 publication.
It is not yet an advertised private-publication endpoint or a public package entry.
The installed Bitcoin/schema validator, actual topic admission bridge, durable
lookup binding, HTTP authentication and final response enqueue still have to be
composed and qualified. A stored or parsed phase is not independent evidence that
those external effects occurred.

## One authoritative private domain

`PrivateServiceDomain.create` explicitly creates an exclusive database; `open`
requires the existing database. Its factory binds seller, chain, store identity,
application configuration, indexing-key label and indexing-key commitment into the
protected ledger's authenticated configuration. Opening with a different identity
or missing key cannot initialize a replacement history. Independent connections
to this same database share native compare-and-swap; separate databases do not
establish global request or funding uniqueness.

The indexing key is a retained 256-bit custody capability. It derives opaque,
purpose-specific record addresses through HMAC-SHA256. Retain it for the lifetime
of permanent fences. Changing it requires an explicit reconciled namespace
migration. Payload encryption keys may rotate separately while every key needed
for a retained record remains available. Provision real custody separately; the
fixed keys in the tests are public synthetic fixtures.

The existing protected ledger encrypts record values and authenticates their
inventory and immutable capacity configuration. It cannot detect rollback of an
entire otherwise valid database. Backup, restoration and operator reconciliation
must preserve the authoritative fences, private bytes, encryption keys and
outstanding obligations together. Public overlay synchronization cannot recover
private material or create private readiness.

## Shared material and independent request fences

`SQLitePrivatePublicationStore.stage` reserves the protected blob and request
fence in one physical transaction. The blob binds chain, topic, transaction,
output index, asset, schema and exact private values. Two request IDs may reference
that one blob, but each retains an independent publication ID, semantic request
digest and progress record. A changed private value conflicts. Exact retry retains
the original record; an independently verified proof variant does not change its
semantic fence or automatically replace retained proof bytes.

The caller must validate actual Bitcoin evidence, current publisher authority and
the installed schema's key/content relationship before staging. The storage parser
checks structure and retained relations; it does not perform those verifications.
Never wire its methods directly to untrusted HTTP events. Supply current installed
authorization guards, including the immutable context and policy premises that
must still hold at the physical commit.

Before accepting work the owner reserves the whole protected blob, a complete
future progress representation and future completion revisions. Native capacity
failure rejects the complete record group. Existing reservations cannot silently
shrink. Terminal fences remain retained; this increment does not implement
unbounded history, deletion, namespace rotation or capacity compaction. These are
explicit outstanding program components, not implicit recovery behavior.

## Durable progression and recovery

The internal progression is staged, admission reserved, admission retained with
binding pending, then ready. A staging deadline may expire work before an effect
reservation. Once admission is reserved, uncertainty remains recoverable even if
that deadline passes. Recovery must query the original operation and admission
receipt; a duplicate submission's empty STEAK is insufficient.

Admission records identify the exact operation, transaction, assessment context,
topic and admitted output. Lookup-binding receipts identify the publication,
semantic request, blob and installed service/rules. The ready transition requires
both retained records in order. Qualified adapters must establish their actual
durability. Readiness loss and verified restoration preserve the original
admission and protected material. The complete retained-record parser checks the
relation again when reopening or loading; it does not trust a ready flag alone.

Every phase change checks the record revision and native global revision. The
current guard runs again at commit, and admission reservation checks the staging
deadline there. Denial or a stale writer cannot partially advance the phase. Clock
observations remain monotonic across rejected work and restart. Current publisher
access and final signed-response disclosure remain service-layer duties; the
internal `load` method returns protected values only to installed local code.

Bounded ledger enumeration supplies metadata in key order for restart work
discovery. A page describes one current read, not a retained snapshot or proof
that all work is complete. Reconciliation must wrap to the beginning after a
pass, reload each candidate, and reserve effects with its current record revision.
New entries behind a previous cursor must not be lost. Enumeration alone grants
no private disclosure or external-effect authority.

## Validation and remaining integration

The adopted foundation passes 266 native tests across 13 suites, including the
existing protected-ledger cases, four actual process-termination boundaries,
independent connections, current-guard revocation, deadline crossings and a
300-case generated publication/restart schedule. The separate publication target
covers all five new implementation files; the protected-ledger target retains
its complete source with work-discovery and full-inventory boundary cases.
Complete mutation qualification, packed documentation/platform checks and final
exact-head CI remain required for this new batch.

The next composition must connect real retained topic admission and durable lookup
bindings, then add authenticated publication/status routes, reconciliation and
native response enqueue. Paid lookup acquisition and purchase/POTATOES delivery
will share the authoritative domain but retain their own evidence, funding,
release and recipient-usability contracts. This storage foundation does not yet
establish those services or complete checkpoint two.
