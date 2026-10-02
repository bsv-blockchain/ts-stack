---
id: protected-private-service-storage
title: 'Protected Private-Service Storage'
kind: guide
version: '1.0.0'
last_updated: '2026-10-01'
last_verified: '2026-10-01'
review_cadence_days: 30
status: experimental
tags: [overlays, privacy, storage]
---

# Protected private-service ledger foundation

This native foundation is an internal storage port for BRC-195/196 service state
machines. It is not a publication endpoint, a paid-lookup implementation, a
purchase entitlement or evidence that a node can deliver private material.
Those services must supply the typed transitions, evidence and authority checks,
original capability retention, recoverable external operations and response
binding described by their profiles.

One SQLite owner atomically updates distinct publication, request/prefix/funding
fence, quote, candidate, acquisition, wallet, admission, delivery and rules
records. These records do not belong in the public catalogue or ordinary output
journal. Addresses are opaque service-local identifiers. A service must derive
retry addresses with a stable keyed index or allocate and retain unpredictable
identities; it must not place raw buyer identities, credentials, keys or private
request bodies in SQL indexes. The future service facade owns that mapping and
its immutable binding.

Creation is explicit and exclusive. Opening requires the same external store
identity, binding, limits and custody; it never initializes missing state.
Creation uses a private file mode and WAL with FULL synchronization. Every open
checks the authenticated inventory and decrypts every retained record so that a
missing old key cannot silently become an apparently empty store. Opening with a
new active encryption key is allowed only while the custody provider can still
resolve all required retained keys.

Every payload is protected by the local AES-256-GCM/HKDF framing. Associated data
binds the format, store identity, immutable configuration digest, record kind,
opaque key, record revision and reserved byte/update capacity. The encrypted
head authenticates the ordered inventory, record ciphertext digests and total
reservations. Missing or mixed record/header state is rejected. Selected record
reads also verify the exact ciphertext digest and authentication tag. Only
fixed-size allocation/index metadata remains outside encrypted bodies. Native
SELECT bounds prevent a corrupt oversized field from being materialized as an
unbounded JavaScript value.

A commit accepts at most 64 distinct records and a 4 MiB owned JSON plan. A record
holds at most 2 MiB of canonical object data. Installations may narrow these
bounds; they cannot advertise more capacity than their custody codec supports.
Larger application evidence needs separately reserved records or independently
durable content-addressed evidence with exact references; it cannot be silently
truncated to fit this primitive. The implementation bounds the ledger to 4,096
records and 64 MiB of reserved plaintext. These are logical budgets, not physical
disk preallocation; the operator must retain disk/WAL/backup headroom for all
accepted obligations. It authenticates a bounded inventory on each transaction; this is not an
unbounded-table or constant-time performance claim.

All related creations/updates compare the original head and individual record
versions in one native write transaction. Duplicate addresses, insufficient
capacity, changed versions or a rejected guard roll back the entire group.
Return values are owned copies. Services reserve empty future records, their
maximum bytes and their remaining update counts before promising a quote or
preparation. A record mutation may consume one previously reserved update;
unrelated work cannot consume the final global revision credits promised to
existing obligations. Reservations cannot be silently reduced. This first
foundation deliberately provides no deletion or automatic compaction API.
Capacity exhaustion stops new obligations; a subsequent archival design must
preserve permanent uniqueness fences and every outstanding delivery promise.

The trusted clock is observed under the native gate. Its durable value never
moves backward and survives ordinary authorization, CAS or work rejection.
A process loss before COMMIT is still an unacknowledged operation; a caller must
reconcile the durable record rather than treating an in-memory observation as a
receipt. Guards are synchronous, receive only a transaction-lifetime reader and
must recheck current authorization and relevant local rules. They must not
perform network, wallet, asynchronous plugin or independent database work while
the gate is held. Such work is prepared outside and committed only after these
fresh checks.

Final synchronous response enqueue uses the same native gate and an expected
head. The enclosing service must first persist the delivery obligation and must
sign the exact response before entering this final guarded operation. An enqueue
error after bytes may have escaped is uncertainty; this port does not retry the
enqueue or claim that the recipient did not receive the secret. Seller delivery,
transport acknowledgement and recipient usability remain separate facts.

Consistent backup must include the entire database and live WAL through SQLite's
backup facilities, plus a separately protected inventory of all custody keys and
the external store/index identity. Encryption cannot detect rollback of an entire
valid database. Restoration must reconcile authoritative funding/request fences,
current privacy rules and outstanding obligations before serving, or retire that
serving identity. Losing a key does not authorize an empty namespace, a new
invoice or a claim that an old paid right disappeared. JavaScript strings are not
reliably zeroizable; temporary byte buffers are cleared on a best-effort basis,
and deployment must protect process memory, diagnostics and backups.

Current isolated evidence includes strict compilation, exact crypto framing and
negative tests, 300 native restart schedules, independent-process CAS races,
actual process termination before and after commit, live authorization changes,
key rotation, inventory/ciphertext corruption, capacity rollback, callback
lifetime checks and the final two reserved revision steps. This is draft evidence.
Adopted-source checks, complete mutation parts/aggregate, exact-head CI and the
full private-service compositions are still required.
