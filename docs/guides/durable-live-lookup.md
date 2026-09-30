---
id: durable-live-lookup
title: 'Durable Progressive and Live Lookup'
kind: guide
version: '1.0.0'
last_updated: '2026-09-29'
last_verified: '2026-09-29'
review_cadence_days: 30
status: experimental
tags: [overlays, application, utxo, lookup, recovery]
---

# Durable Progressive and Live Lookup

This guide describes the unpublished BRC-193 provider candidate and its opt-in
Overlay Express transport. A lookup starts with a fixed snapshot, then continues
from the same provider's durable change history. Several independent providers
can supply an application concurrently. Each has its own membership, access and
continuity; combining their answers does not manufacture a shared global order.

The provider indexes observations. The receiving application's output-knowledge
runtime separately verifies Bitcoin evidence and reconciles spends. A lookup row,
a transport signature or an index commit is not proof that an output is valid or
unspent. Wallet signing and payment remain explicit application operations.

## Components and package boundaries

`@bsv/output-knowledge/lookup` contains `LookupProviderService`,
`LookupProviderContracts`, installed query policies, record codecs, bounded work
control and notification hints. Its storage ports are backend neutral and its
browser bundle excludes SQLite. `@bsv/output-knowledge/lookup/sqlite` contains
`SQLiteLookupIndex` and `SQLiteLookupSessions`; use Node 22.13 or newer. The two
SQLite adapters share the same actual connection and transaction domain.

The index owns versioned rows, atomic domain changes and retained history. The
session store owns original requests, selected signed contracts, encrypted-cursor
keys, history pins, deadlines and disclosure guards. The query policy deterministically
maps rows and complete changes into observations. The service composes these
parts; transport supplies the verified caller and selected capability digest.

`@bsv/overlay-express/output-lookup` exports `createOutputLookupRouter`. Its
structural companion interface accepts the provider service without making the
dual-format Express package import an ESM-only runtime. Alternatively, call
`OverlayExpress.configureOutputLookup` before `start`. This installs the same
router and reuses the host's authentication instance and request capacity. The
new adapter requires SDK 2.9.0. Existing finite lookup routes and the legacy root
entry remain compatible and do not eagerly load the optional adapter.

The [compiled package example](compiled-package-examples.md#durable-lookup-provider)
checks these public entry points together from packed artifacts. The provider and
HTTP suites exercise actual SQLite and BRC-103/104 authentication. Neither is a
claim that the full BRC-192–199 program or a production deployment is complete.

## Initialize once, reopen deliberately

Allocate a protected database path and immutable namespace binding for a new
service. Construct `LookupQueryRegistry` with locally installed policies and their
parameters, then `LookupProviderContracts` with the expected base URL, identity,
chain, service and a callback returning the current signed manifest. Construct
`LookupSessionCodec` with `contracts.recoveryTrust()`.

For initial creation use `SQLiteLookupIndex.create` and
`SQLiteLookupSessions.create`. Initialize the service's disclosure guards and
allocate one storage epoch with `sessions.createEpoch()`. Put that epoch into the
signed manifest using `lookupServingEpochExtension`. Retain the resulting manifest
and epoch as host configuration before serving. New manifests may renew discovery
lifetimes without changing this storage generation.

For a normal restart use the explicit `open` constructors with the same binding,
record limits and capacity configuration. Reuse the saved serving epoch. Do not
call `createEpoch` merely because a process restarted. Explicit opening refuses
missing state; a missing database must never silently become an empty successful
recovery. A deliberate fresh store needs a fresh epoch and a newly signed selector.
Original requests against a lost selector must fail instead of selecting a second
snapshot under the same request identity.

Epoch rotation retires earlier epochs for new openings while preserving retained
original requests and sessions. The service can recover an original wire selector
after discovery rotates or its manifest expires. It uses the saved exact contract,
not today's different limits or rules. Keep every required installed query policy
available through its promised retention period. An incompatible policy change
needs a separate service or an explicitly managed continuity reset.

## Publish complete domain changes

A producer first performs its own admission, evidence and application checks.
Prepare one `LookupIndexMutation` containing the observed index `base`, evaluation
time, all row edits and bounded event data. Each edit carries its exact prior row
revision, or `null` to require absence. `index.commit` checks the complete head and
all predicates, then atomically writes every row version and one indivisible
change group. It never partially publishes a replacement or silently overwrites
a concurrent producer.

After an uncertain acknowledgement, retry the exact original mutation or inspect
its retained result. Do not change its base and call that the same operation.
Retained exact retries recover the committed group; a new conflicting operation
must reread and be replanned by its owner. Once history is compacted, its old retry
result is unavailable and cannot be recreated as a new write at the old head.

Call `provider.wake.notify()` after a committed change to reduce latency for local
readers. This is only a hint. A reader registers its watch before checking durable
state and also polls at a bounded interval. Writes from another connection or
process therefore remain observable without sharing an in-memory event emitter.
A notification alone never advances a cursor or proves durable publication.

The neutral `CollectionOutputQueryPolicy` uses query `{ collection: string }` and
empty rule parameters. Rows contain `collection`, `audience` (`'public'` or a
canonical sorted list of identity keys), and `output` with evidence and optional
context. `collectionOutputIndexKey` assigns canonical outpoint ordering. Every
reader selected by a row's audience can see that row's context: never put a secret
in a public row. This example policy emits output membership and withdrawal; a
withdrawal does not assert a Bitcoin spend. A custom installed policy may map
complete domain events to richer observations under its own precise rule identity.
Remote rule identifiers never load executable code.

## Snapshot and continuation promises

Opening drains all independent row timers through evaluation time `T`, then
captures index watermark `W`. If bounded timer work cannot finish, opening fails
explicitly; it cannot claim a complete snapshot that omitted due expirations.
Rows inserted after `W` cannot enter that snapshot. Rows removed later remain
visible at `W` while the original history promise remains valid.

The original request, selected contract, session secrets, first serialized batch
and history pin commit together. An exact retry returns the original first batch
subject to current authorization and its fixed deadlines. Two concurrent original
opens converge on the same saved operation. Changing the query or initial limits
under that request identity is a conflict, not a replacement operation.

A final snapshot batch still has phase `snapshot`, even when empty. Its outgoing
cursor points to live history immediately after `W`. A subsequent read delivers
whole domain changes after `W`, including writes made during snapshot ingestion.
Live group identities do not depend on response size or a session's rebatching.
A change that cannot fit alone returns an explicit limit; it is never split.
Optional minimum-byte diagnostics describe an immediate read with the minimum
observation allowance needed for that group, including the allowance's own serialized
digits. A permanent failure means no permitted read limits can fit it; a large
requested wait or observation allowance cannot manufacture that classification.
Irrelevant rows consume scan budget, and sparse scans may advance an opaque cursor
without fabricating observations. A quiet poll with no progress keeps its cursor. Each empty database check also
consumes one scan unit. Repeated notifications without new state cannot create
unbounded database work; exhausting the work budget may return a read early.

Session expiry and original-response replay deadlines are fixed at opening.
Retries, reconnects and close do not extend them. Close is private and idempotent;
it does not reveal whether an unknown session exists. Closed payloads and pins
remain until their promised retention ends. Expired original-request fences prevent
an old request from becoming a new snapshot after payload compaction.

## Current authorization and private history

The host supplies `authorize` for both request and disclosure stages. It receives
the verified principal, original query, selected contract and existing access
partition. Return a stable access partition and the durable guards protecting its
privacy, root-serving and access state. The final session-store serialization
checks these guards, the principal, the partition and deadlines in the same
synchronous transaction that produces the response body. Send those bytes without
appending rows, rehydrating context or performing another unguarded disclosure.

Every writer of the relevant external policy must participate. When a change spans
an external policy database and the lookup store, persist `blockGuard` first with
a durable operation identity. Both old and new disclosures then stop. Complete the
external policy/index change durably, and only then call `releaseGuard` for that
same operation. A crash leaves the guard blocked; recovery must reconcile the
external operation before releasing it. The reference store does not magically
make two independent databases atomic. A pure continuity invalidation can use
`advanceGuard`; it is insufficient for an external privacy change with a race window.

Removing membership from the index alone is not a revocation of old snapshot
access. Use the current authorization gate and relevant guard when prior data must
stop being disclosed. A retained first response or encrypted cursor is never an
exemption from that gate. The boundary is response serialization: already disclosed
bytes cannot be revoked from a recipient or recalled from an outbound network buffer.

## HTTP composition

Bind one lookup service/profile per concrete base path. For base
`https://lookup.example/api`, the router serves
`/api/overlay/v1/capabilities` and `/api/overlay/v1/lookup/open`, `read`, `close`.
The BRC-103 handshake remains at the origin's `/.well-known/auth`. Multiple mounted
companions must use the same origin's authentication instance and install that
handshake once. Set `handleHandshake: false` on secondary standalone routers.

Mount standalone routers at the Express application root before generic body
parsers, compression, caches and payload logging. Exact raw bytes are authenticated
before JSON framing is validated and parsed data reaches the companion. The
router rejects duplicate headers, compressed request
bodies, malformed JSON and unsupported negotiation. It binds each response to the
selected capability/profile, uses private no-store headers, exposes only the
needed authentication/selection headers to explicitly allowed browser origins, and
cancels service work when the connection closes. It does not run payment middleware.

`configureOutputLookup` checks that an authenticated host's server wallet identity
matches the configured capability identity, shares its existing authentication
middleware, and clamps byte budgets to host edge limits. A manifest advertising
larger limits is rejected. New lookup routes require a verified principal even
when legacy routes intentionally allow anonymous callers. The owner closes provider
storage only after serving requests have drained; the host does not assume ownership
of an injected database.

## Capacity, retention and operations

The default physical service budget is 64 requests, four per principal and a
30-second request deadline, with no queue. All anonymous callers share one principal
bucket. Cancelled or timed-out work retains capacity until its actual I/O settles;
otherwise a reconnect loop could create unbounded background work. HTTP sockets
have a separate bounded pool. TLS, Node header/body deadlines, proxy timeouts and
physical authentication work remain host configuration.

The index defaults to 65,536 keys, 262,144 versions, 65,536 groups and pins, and
256 MiB logical record bytes. Sessions default to 64 epochs, 1,024 guards, 65,536
original fences and session payloads, 256 retained sessions per principal, and
256 MiB logical payload bytes. Record and request limits apply independently.
These are logical admission bounds, not filesystem, SQLite page or WAL quotas.
Monitor disk space, checkpoint/backup behavior and process memory separately.

Compaction runs in bounded steps. Active history pins constrain the floor; retain
the baseline row version at that floor and all later changes. Payload compaction
keeps original fences. Collect an epoch only after it is retired and every replay
promise has ended; never discard a live promise to make room. Capacity exhaustion
is an explicit operational condition. Recovery and retention tests include process
loss before and after commit, independent writers and rollback during compaction.

Protect database parents, WAL files and backups as private state. New files are
owner-only and WAL commits use `synchronous=FULL`. Use an online SQLite backup that
includes committed WAL state and preserve host epoch/configuration with it. Restoring
an older backup requires a deliberate new serving generation; local checksums do
not prove that a malicious or rolled-back database contains all promised history.
