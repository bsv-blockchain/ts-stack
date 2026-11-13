---
id: protected-operation-objects
title: 'Immutable Protected Operation Objects'
kind: guide
version: '1.0.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
review_cadence_days: 30
status: experimental
tags: [overlay, custody, recovery, browser, wallet]
---

# Immutable protected operation objects

A recoverable operation needs its original inputs as well as its eventual result.
The small encrypted workflow cell holds progress and references. The operation
object store retains larger original requests, selected capability contracts and
delivered payloads. Each has a distinct immutable identity and role binding.
A storage receipt establishes that these exact bytes were retained locally. It
does not establish the seller's authority, transaction validity, settlement,
material usability or permission to disclose the material.

The shared `ProtectedOperationObjectStore` interface has three operations.
`reserve` commits an explicit bounded reservation for an object identity and its
original binding. `put` fills that reservation exactly once. `read` reports
absence, the original reservation, or the first retained bytes and their digest.
A byte-identical retry returns the first receipt. Different bytes, bindings or
reservation sizes cannot replace it. Absence does not create a record, and `put`
cannot implicitly reserve one. There is no deletion or automatic compaction API.

An application must reserve every promised object before authorizing a financial
effect. For an acquisition, this includes the original request, selected contract
and maximum delivered result, with separate identities and role bindings. Store
only their exact receipts and small progress fields in the encrypted control
cell. If initialization stops halfway through, reconcile the same original
reservations before proceeding. A half-finished initialization does not authorize
a payment or a new operation identity.

## Install the original owner explicitly

`@bsv/output-knowledge/operations/objects` provides the browser IndexedDB owner
and shared interfaces. The native SQLite owner is isolated in
`@bsv/output-knowledge/operations/objects/sqlite`. Neither is added to the existing
`operations` or `operations/protected` export graph. Existing stores, schemas,
exports and bundle budgets remain unchanged.

Both owners require an independently retained `storeId`, recipient identity,
public installation binding and capacity configuration. Keep private per-object
bindings inside the encrypted records. Recover with the exact original
configuration and custody; opening never creates a missing installation.
Native creation is exclusive. Browser creation is idempotent for an existing
original installation, but does not repair a missing head or invent lost data.

The browser owner accepts the explicit `ProtectedOperationPayload` capability.
For BRC-100 wallet custody, supply `WalletProtectedOperationPayload` from
`operations/protected` using the selected recipient's identity. Its wallet key
material stays with that wallet. The selected database factory, original
configuration and custody methods are retained before asynchronous initialization.
The SQLite owner accepts the existing `NodeProtectedPayloadCodec` and composes
above the existing protected ledger. Supply an independently managed original
key provider; the store does not generate, export or replace a custody root.
These custody capabilities do not install payment or disclosure authority.

## Bounds and reservation guarantees

Each object is bounded by the installed `maximumObjectBytes`, at most four MiB.
Larger values use bounded chunks; the complete header and all future chunk slots
are reserved before an object can be filled. Selecting a smaller limit for an
individual object does not create more object slots than `maximumObjects` permits.
The original selection still limits that object's actual bytes.

The shared installation limits include at most 1,024 objects, 4,096 reserved
records and 64 MiB of plaintext framing. These constraints apply together, so a
four-MiB object configuration supports fewer objects than a small-object
configuration. The browser additionally requires every complete header, chunk
and inventory frame to fit the supplied codec, and caps the sum of full declared
ciphertext capacity across reserved rows at 128 MiB. Choose the codec and
installation capacities together before initialization. A configuration that
cannot satisfy the complete reservation is refused.

These are logical capacity guarantees. They cannot reserve physical browser
quota, prevent eviction, ensure free disk space or replace a backup policy. A
quota failure aborts the whole local transaction. An uncertain commit is resolved
by reopening and reading the same original object, not by paying again.

## Atomic retention and recovery

The native owner uses the existing protected ledger's transactional reservation
and completion rules. The browser owner keeps an authenticated encrypted
inventory alongside encrypted headers and chunks. It prepares encryption outside
IndexedDB transactions, then commits all changed records and the new inventory
in one strict-durability transaction after comparing the exact previous head and
requested rows. Another connection can win while encryption is running. The
losing writer reports a conflict and can reconcile the original identity.
There is no hidden retry loop that chooses another result.

Reads check the authenticated inventory, addresses, ciphertext digests, original
binding, chunk lengths and complete result digest. Missing or mixed records fail
closed. Returned byte arrays and configurations are independent copies; callers
cannot mutate the retained first result through a returned object. Explicit
close prevents further local work. Drain outstanding work before closing custody.

Encryption and inventory authentication do not detect restoration of an entire
earlier valid database. Preserve external continuity evidence and coordinate
whole-store/key backups. Losing original custody or restoring an older copy must
not be interpreted as proof that a payment never happened. Retained but unusable
material remains the original result; validation and an application's resolution
policy are separate from byte retention.

## Qualification and integration

The component tests cover chunk boundaries through four MiB, original-role
separation, reservation exhaustion, changed custody, mixed records, quota aborts,
competing writers, generated native/browser recovery histories and native process
termination. The browser fixture also exercises actual IndexedDB, wallet
encryption, browser restart and competing tabs under a restrictive CSP. Packed
exports, complete mutation campaigns and exact-head hosted checks remain required.
An outside-source browser proof alone is not package qualification.

The complete durable acquisition owner must still coordinate this storage with
its protected control state, explicit recoverable wallet action, selected seller
transport and independent material validation. These object APIs perform none of
those network or financial actions on their own. See
[paid lookup clients and protected workflow state](./paid-lookup-client.md) for
those boundaries.
