---
id: output-knowledge
title: '@bsv/output-knowledge'
kind: package
domain: application
npm: '@bsv/output-knowledge'
version: '0.1.0'
last_updated: '2026-09-29'
last_verified: '2026-09-29'
review_cadence_days: 30
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/application/output-knowledge'
status: experimental
tags: ['application', 'utxo', 'overlays', 'state']
---

# @bsv/output-knowledge

This initial, unpublished package provides opt-in application output knowledge above
`@bsv/sdk`. It separates source membership, Bitcoin evidence, spend selection,
currentness and application projection. Receiving data never authorizes a wallet
action. The implementation branch is still being qualified; this page does not
announce a registry release or completed BRC-192–199 implementation.

## Public composition

`BitcoinKnowledge` implements the trusted protocol reducer and worker.
`KnowledgeStore` binds it to an account partition and a receipt journal.
`OutputKnowledge` attaches bounded source adapters and an optional pure domain
projector. `SDKEvidenceVerifier` checks exact-target BEEF using an application-owned
immutable header view. The caller explicitly selects whether non-final candidates
participate in reconciliation.

The optional `@bsv/output-knowledge/sources` entry contains the source adapters.
`WalletOutputSource` ingests bounded BRC-100 basket pages with explicit aggregate
BEEF targets. `LookupOutputSource` preserves each configured host's receipts before
resolver deduplication; concurrent sources provide progressive federated results.
`DirectDeliverySource` bridges a configured peer transport to durable receipt
acknowledgement, with explicit opt-in for volatile storage. These finite adapters
do not claim atomic wallet snapshots or resumable BRC-193 live continuity.

`MemoryJournal` is volatile. `IndexedDBJournal` is browser compatible.
`SQLiteJournal` is available only from `@bsv/output-knowledge/sqlite` and requires
Node 22.13 or newer. The browser root never imports SQLite. All three adapters use
idempotent mutations and compare-and-swap revisions; SQLite and IndexedDB atomically
retain receipt, checkpoint and local verification material.

The [package guide](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/application/output-knowledge/README.md)
contains composition examples, recovery semantics, resource limits and the current
qualification boundary. Exact exports and declarations are listed in the
[generated API ledger](../../reference/package-api-migrations.md).

## Behavior and boundaries

A source group's evidence qualifies as a whole. A later verification result cannot
move its original receipt position or outrun an earlier complete competing proof.
Missing predecessors remain unresolved; facts from another authorized source can
complete them. A source withdrawal changes only that source's membership. It does
not spend an output or erase a verified transaction. An empty replacement snapshot
also requires an accepted boundary before it clears previous membership.

Conflicting source identities are retained in a bounded quarantine after complete
trusted-session validation. The failed generation requires a fresh snapshot;
original identities, independent facts and other providers remain intact. A local
reconciliation publishes the continuity change, including after restart. Local
journal inspection retains the full claim; public knowledge diagnostics omit its
private contents. Capacity exhaustion is explicit and never silently drops claims.

The worker persists enough locally validated material to reconstruct accepted
history without contacting the verifier again. New contexts invalidate current
selection until evidence qualifies in that view; historical replacements and facts
remain retained. The default currentness policy reports unknown, spent, conflicted
or stale. Creation evidence alone never becomes a claim of global unspentness.

Optional `sourceCurrentness` rules bind provider reports to exact configured
source identities, retain each actual epoch, and expire from the original trusted
receipt. Expiry is journaled even without new source traffic; reads refuse an
expired assessment while a delayed timer catches up. A source invalidation cannot
change local Bitcoin facts or another provider's report. Enabling these rules uses
local frame version 2 and requires a new namespace when changing an existing policy;
empty-policy version-1 journals remain readable without migration.

Proposal admission, authenticated BRC-193 service transport, private acquisition and full application demonstrations are separate
parts of the active implementation program. Existing finite lookup and submission
interfaces remain unchanged.

## Migration and validation

Existing applications need no migration until they opt into these new ports. Keep
existing wallet actions explicit and supply a separate store namespace for each
application/account/access partition. Changing the non-final policy requires an
explicit new journal generation; keep the previous journal for audit and recovery.

The current tests cover actual SDK Script/SPV evidence, whole-group barriers,
SQLite recovery with network access disabled, cross-source predecessor completion,
source-generation replacement, non-final history during context changes and a
snapshot/live withdrawal through the public runtime. Browser persistence still
requires actual-browser qualification beyond the fake-indexeddb unit tests. All 32 approved reconciliation traces now run through the default worker and
SQLite with delayed verification and offline restart. Service, application and
remote CI gates remain required before review.
