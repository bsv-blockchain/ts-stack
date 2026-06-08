# BRC-136 BASM Synchronization & Admin/Janitor Removal

This document explains how the BRC-136 Block-Anchored synchronization layer
([spec](https://bsv.brc.dev/overlays/0136)) is implemented in this engine, and —
critically — **how it interacts with admin and janitor removal of outputs from a
topic**. The two systems are deliberately decoupled. Read the final section
("How BASM and removal interact") before operating a node that runs the janitor
or removes tokens via the admin API.

## What BRC-136 gives you

GASP ([Synchronization.md](./Synchronization.md)) replicates transaction *data*
between peers. BRC-136 sits alongside it and answers a different question:

> Do two overlays **agree about which transactions were admitted to a topic** at
> every block height, from the topic's genesis to the chain tip?

It does this with a per-topic **Topic Anchor Chain (TAC)** — a cumulative hash
that commits to every block's admitted-transaction set. If two nodes report the
same `TAC(topic, H)`, they provably agree on every admitted transaction for that
topic from genesis through height `H`. A single round trip detects agreement; a
binary search over heights localizes any divergence in `O(log H)` rounds.

### Core data structures

| Concept | Type | Source of truth |
|---|---|---|
| Admitted set at a block | `AdmittedTxRef[]` | `applied_transactions` table |
| Block anchor | `TopicBlockAnchor` | `topic_block_anchors` table |
| Cumulative chain hash | `tac` field on the anchor | derived |

- **`basmRoot`** — Merkle root over the admitted txids at one block height, in
  canonical block order. Empty set → 32 zero bytes; single txid → the txid
  itself (unhashed); multiple → `SHA256d` binary tree with Bitcoin odd-leaf
  duplication. See `computeBasmRoot` in `src/BASM.ts`.
- **`tac`** — `SHA256d(prevTac ‖ blockHash ‖ basmRoot)`, all inputs in internal
  byte order. See `computeTac` in `src/BASM.ts`.

### Gap-free chains

The TAC must advance on **every** block — including blocks with no admitted
transactions — or peers could not distinguish "no transactions here" from "I
haven't synced this height." The engine keeps chains contiguous:

- `advanceTopicAnchorChains(toHeight)` extends each topic forward with empty
  anchors (zero root, zero count) up to `toHeight`.
- `rebuildTopicAnchorChain(...)` / `recomputeTopicBlockAnchor(...)` rebuild a
  contiguous slice after an admission (including out-of-order proofs), filling
  any missing heights with empty anchors rather than leaving a hole.

A chain only *starts* at the topic's first admitted height (its genesis).
Covered by `src/__tests/BASMChain.test.ts`.

## The admitted set is a historical fact, not current UTXO state

This is the key design decision, and the source of the assurance this layer
provides.

The admitted set for `(topic, height)` is read by
`Storage.findAdmittedTransactionsForBlock`, which queries:

```
applied_transactions WHERE topic = ? AND blockHeight = ? AND proven = true AND blockIndex IS NOT NULL
```

It is **append-only for proven transactions**. A row lands here when a
transaction is admitted to the topic and has a merkle proof
(`buildAppliedTransactionRecord` sets `proven: true` only when proof metadata is
present). From that point the row — and therefore the `basmRoot` and `tac` that
commit to it — is an immutable record of "this overlay received and admitted
this txid at this block height."

It is **not** derived from current unspent outputs. Spending an output, pruning
its history, or removing it from lookup does not change the admitted set.

## The lookup set is separate, mutable, and policy-driven

What an overlay *serves* in lookup responses is a different set, in different
storage:

- The engine `outputs` table, filtered to `spent: false`.
- The lookup service's own index (e.g. the Mongo `shipRecords` / `slapRecords`
  collections for the discovery services).

This set is mutable by design. Outputs get marked spent, pruned from history,
removed by an admin, or deleted by the janitor.

## Removal paths — exactly what each one touches

| Path | Code | Touches lookup set | Touches admitted set (`applied_transactions`) |
|---|---|---|---|
| Spend / history prune | `Engine.deleteUTXODeep` → `deleteOutput` | yes | **no** |
| Admin remove-token | `/admin/remove-token` → `evictFromServices` → `LookupService.outputEvicted` | yes (lookup index) | **no** |
| Janitor (dead SHIP/SLAP host) | `JanitorService.handleUnhealthyOutput` → `deleteOne` + ban | yes (lookup index) | **no** |
| Ban enforcement | `BanAwareLookupWrapper.outputAdmittedByTopic` | blocks re-entry into lookup index on GASP re-sync | **no** |
| Unproven eviction | `Engine.evictUnprovenTransactions` → `deleteAppliedTransaction` | yes | yes — **but only `proven: false` rows** |

Notes:

- **`deleteUTXODeep` never deletes the applied-transaction record.** It calls
  `deleteOutput` only. The admission proof survives a normal spend or prune.
- **Admin and janitor removal operate on the lookup layer only.** Admin
  `evictFromServices` calls `LookupService.outputEvicted`; the janitor deletes
  from its own Mongo collection and writes to the ban list. Neither calls
  `deleteAppliedTransaction`, `deleteOutput` on proven engine state, or anything
  that mutates `topic_block_anchors`.
- **The ban list is a lookup-layer filter.** `BanAwareLookupWrapper` blocks
  banned outpoints/domains at `outputAdmittedByTopic`, preventing a removed token
  from re-entering the *lookup index* when GASP re-syncs it from a peer. It does
  not — and must not — block the BRC-136 admitted record.
- **`evictUnprovenTransactions` is the only path that deletes an
  applied-transaction row**, and it filters to `proven: false`. Such rows never
  appear in any anchor (the anchor query requires `proven: true`), so evicting
  them cannot change any `basmRoot` or `tac`.

## How BASM and removal interact

This is the question operators most need answered.

### You can always prove you received and processed a token

Even after the janitor deletes a dead host's advertisement, or an admin removes a
malicious output via `/admin/remove-token` (with or without a ban), the overlay
**retains full proof that it received and admitted that token**:

- the `applied_transactions` row (`proven: true`, with `blockHeight`,
  `blockIndex`, `blockHash`, `merkleRoot`),
- the `topic_block_anchors` row whose `basmRoot` commits to that txid, and
- the ability to serve a compound merkle path for it via the BRC-136 endpoints.

Removal is a **lookup-serving policy decision**. It changes what the node returns
to lookup queries. It does not, and cannot, rewrite the historical admitted set
or the TAC.

### TAC agreement means agreement on *admission*, not on *lookup results*

This is the most important operational caveat:

> **A matching TAC proves two overlays agree on which transactions were admitted.
> It does NOT prove they will return identical lookup results.**

Bans and removals are **per-node policy and are not synchronized between peers**.
Two honest overlays running the same topic manager can therefore:

- report the **same** `TAC(topic, H)` (identical admitted sets), while
- returning **different** lookup results — because one node banned a malicious
  output that the other still serves.

This is correct and intended. BRC-136 anchors *receipt and admission*, which is
an objective, deterministic function of chain state and the topic manager. It
intentionally does not anchor each node's local moderation policy.

### Consequence: divergence diagnosis

- **TACs match** → the two nodes admitted exactly the same transactions. Any
  difference in lookup output is explained by local removal/ban policy, not by a
  sync problem.
- **TACs diverge** → the nodes genuinely disagree about admission at some height
  (e.g. different topic-manager versions, a missed transaction, or a reorg
  handled differently). This is a real sync issue; the binary-search localizes
  the height.

Removing a token from lookup will **not** cause TAC divergence. If you ever see
TAC divergence after only running the janitor/admin removal, that is a bug —
something is incorrectly deleting proven `applied_transactions` rows or mutating
anchors.

### Caveat for the GASP validation guidance

[Synchronization.md](./Synchronization.md) suggests validating sync by comparing
per-topic SQL row counts across nodes. Once the janitor or admin removal is
active, **lookup-set counts can legitimately differ between nodes even when their
TACs match**. To validate BRC-136 agreement, compare `TAC(topic, tip)` between
peers — not lookup row counts.

## Verification checklist for operators

1. After removing a token, confirm its `applied_transactions` row still exists
   (`proven: true`) and the `topic_block_anchors` row for its height is unchanged.
2. Confirm `TAC(topic, tip)` is unchanged by the removal.
3. Confirm the token no longer appears in lookup responses (and, if banned, does
   not reappear after a GASP re-sync).

If all three hold, removal is behaving correctly: the node no longer serves the
token, yet can still prove it was received and admitted.
