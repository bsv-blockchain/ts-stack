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

The optional `@bsv/output-knowledge/proposals` entry installs immutable policy
descriptions and validates actual author signatures, selected chain/service,
policy-specific payloads, signed revision relations and exact finalization bytes.
`AuthorDocumentPolicy` implements BRC-194's concrete canonical document example,
including fixed recipients/anchor and its one-satoshi PRP1 finalization output.
Policy authorization must still intersect with the host's current access policy.
These pure checks do not persist a channel, verify Bitcoin evidence, authorize a
wallet action or perform topic admission; the durable service layer is separate.
`ProposalTransitions` supplies pure lifecycle plans that reserve exact admission
jobs, retain uncertain results and serialize expiry against finalization. Its plans
require an atomic storage adapter for the head, operation binding and lifecycle
events before any admission effect. It preserves historical finalized/failed
outcomes separately from current chain assessments.
`MemoryProposalJournal` is explicitly volatile; `SQLiteProposalJournal`, from
`@bsv/output-knowledge/proposals/sqlite`, durably commits the same transitions and
private events together. It preserves retry bindings, pending jobs and terminal
fences across process loss. The reference journal seals its service identity and
configuration and refuses silent resets. Its bounded full-history retention is
not a completed service compaction or capability-recovery implementation.
Local recovery context can be retained atomically alongside a transition without
changing older entry encodings or retry keys. New admission jobs reserve capacity
for a bounded terminal receipt; concurrent writers share sealed capacity limits.
Hosts must validate retained context and bound receipts before admission. An older
journal's pending jobs are preserved but do not gain a retroactive capacity promise.
`ProposalCapabilityContracts` binds saved selections to exact installed policy
parameters and lifetime limits. An installed policy omitted from the selected
manifest remains disabled for that operation. The optional `getProposalEntry`
storage read retrieves a proposal's latest atomic record and context together.
`ProposalService` adds durable publication, current authorization, expiry,
finalization reservation and exact-operation recovery. It retains original
publication/admission contracts and preflights terminal receipt and response
capacity. Authenticated transport and durable admission remain explicit integration ports.
`SDKProposalEvidence` performs complete target BEEF/Script verification against
a pinned immutable chain view. A signed PRP1 fixture with synthetic header ancestry
exercises that adapter before SQLite reservation; ordinary admission remains
unresolved in that test. Full HTTP/topic qualification remains in progress.
Its optional richer evidence method retains the original verification context
atomically with the reservation in local `proposal-service/2` records. Recovery
passes that saved context to admission without adopting a new view or policy;
adapters can require it explicitly. Original v1 records and string-returning
ports remain supported, but missing context is never synthesized for an adapter
that requires it. Upgrade readers before writing v2; no wire migration is needed.
The package guide describes each port's required behavior.

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
change local Bitcoin facts or another provider's report. New journals seal these
rules in local frame version 3 and use canonical assessment ID order. Older
version-1 and version-2 journals retain their recorded presentation and remain
readable and writable without migration. Changing an existing policy or adopting
version 3 for an older journal requires an explicit new namespace; no saved history
is silently upgraded or downgraded.

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
