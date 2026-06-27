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

## Reorg handling

A blockchain reorganization can orphan a block whose transactions were already
admitted and anchored. Since anchors and the admitted set are keyed by
`(topic, blockHeight, blockHash)`, an orphaned block would otherwise leave stale
`applied_transactions` rows and an anchor whose `basmRoot`/`tac` commit to a
block hash that is no longer canonical — permanently diverging the TAC from peers
that observed the reorg. The engine reconciles this automatically.

### Chaintracks is the reorg authority

Reorg detection is **not** reinvented here. The production chain tracker should
be a go-chaintracks compatible service. Arcade exposes go-chaintracks under
`/chaintracks/v2`, and a standalone go-chaintracks deployment may expose the same
API at `/v2`:

- **Arcade-mounted Chaintracks:** `GET /chaintracks/v2/reorg/stream`
- **Standalone go-chaintracks:** `GET /v2/reorg/stream`

The stream emits `data: <JSON>\n\n` frames (no `event:`/`id:` lines;
`: keepalive` comments between events). Each frame is a `ReorgEvent`:

  ```jsonc
  {
    "orphanedHashes": ["<blockHash>", ...], // blocks removed from the active chain
    "commonAncestor": { "height": 100, "hash": "..." },
    "newTip":         { "height": 103, "hash": "..." },
    "depth": 3
  }
  ```

- The same go-chaintracks-compatible service answers the merkle-root checks
  (`isValidRootForHeight`) the engine already trusts for SPV verification.

`packages/overlays/overlay-express/src/ReorgStream.ts` consumes this stream and
maps each event to the engine: `orphanedHashes` → blocks to reconcile,
`commonAncestor.height + 1` → rebuild floor, `newTip.height` → rebuild ceiling.
Block hashes are lower-cased to match stored display-hex hashes (go-sdk
`chainhash.Hash` marshals as reversed/display hex).

> **No replay on this stream.** It carries no event ids, so a reorg that fires
> while the SSE client is disconnected is lost. Every (re)connect therefore runs a
> catch-up revalidation sweep (below), and the periodic block poll runs the same
> sweep as a standing fallback for chain trackers that expose no reorg stream.

### What the engine does on a reorg — `Engine.handleReorg`

1. **Demote orphaned admissions.** For each orphaned block hash, every **proven**
   `applied_transactions` row anchored to it is demoted to unproven
   (`demoteAppliedTransactionToUnproven`): block height/hash/index/merkleRoot are
   cleared and `proven` is set to `false`, **but `firstSeenHeight` is kept**. The
   transaction immediately leaves the admitted set.
2. **Rebuild affected anchor chains.** Every topic whose chain intersects the
   reorged height range is rebuilt over the **canonical** block hashes (the rebuild
   forces header re-resolution rather than reusing the stale stored hash). Topics
   with no demoted transaction are rebuilt too, because the canonical block hash
   for those heights changed and the `tac` must re-chain over it.

`handleReorg` is **idempotent**: a clean window demotes nothing and reproduces an
identical TAC, so it is safe to run on every reorg event, SSE reconnect, and poll.

### Fallback / catch-up — `Engine.revalidateRecentAnchors(depth = 3)`

Scans proven `applied_transactions` in `[tip - depth + 1, tip]`. Any row whose
proof root no longer validates (`isValidRootForHeight`) or whose block hash
diverges from the canonical header is treated as orphaned and fed into
`handleReorg`. This is the reorg path for chain trackers without a reorg stream,
and the catch-up step on every SSE reconnect. Default depth is 3 blocks
(`reorgScanDepth`, configurable via `configureReorgStream`).

### Interaction with admin/janitor removal

Reorg recovery and lookup-layer removal are independent and do not interfere:

- Removal/bans touch only the lookup layer; they never demote `applied_transactions`.
- Reorg demotion touches only the admitted set (proven → unproven) via the chain
  tracker; it never consults the ban list or lookup index.

A demoted transaction follows the engine's unproven lifecycle. The preferred
maintenance path is refresh-before-evict:

1. If the transaction is re-mined and a provider calls `/arc-ingest` with a
   proof, `handleNewMerkleProof` re-proves it at its new height and the anchor
   includes it again.
2. If no callback arrives, `refreshUnprovenTransactionProofs` asks configured
   proof providers such as Arcade for a fresh proof.
3. `maintainUnprovenTransactions` refreshes proofs first, then calls
   `evictUnprovenTransactions` for rows that are still unproven past the
   configured threshold.

The "we received it" record survives until a proof, a terminal provider
invalidation, or age-based eviction resolves it.

### Provider invalidation and double spends

Provider callbacks can also report terminal rejection. When `/arc-ingest`
classifies a callback as double spend or another terminal invalid outcome, the
Express layer evicts the applied transaction immediately through
`Engine.evictAppliedTransaction`. This removes the transaction from the admitted
set and notifies lookup services through their `outputEvicted` path. It is more
important to stop serving rejected data than to wait for the normal unproven
eviction threshold.

### Configuration

```ts
server.configureChaintracks('https://arcade.example', {
  apiPrefix: '/chaintracks/v2',
  reorgStream: true,
  scanDepth: 3
})

server.configureEnableBASMSync(true)
server.configureUnprovenMaintenance({
  thresholdBlocks: 144,
  intervalMs: 60 * 60 * 1000
})
```

- `apiPrefix` — `/chaintracks/v2` for Arcade-mounted Chaintracks; `/v2` for many
  standalone go-chaintracks deployments.
- `reorgStream` — when enabled, the SSE adapter reconciles reorgs in real time.
- `scanDepth` — sweep depth from tip (default `3`).
- `thresholdBlocks` — how old an unproven row must be before maintenance tries
  proof refresh and eviction.
- The block poll (`basmBlockPollIntervalMs`) runs the sweep as a fallback even
  when no stream is configured.

## Verification checklist for operators

1. After removing a token, confirm its `applied_transactions` row still exists
   (`proven: true`) and the `topic_block_anchors` row for its height is unchanged.
2. Confirm `TAC(topic, tip)` is unchanged by the removal.
3. Confirm the token no longer appears in lookup responses (and, if banned, does
   not reappear after a GASP re-sync).

If all three hold, removal is behaving correctly: the node no longer serves the
token, yet can still prove it was received and admitted.

### Reorg verification

4. After a reorg orphans an admitted transaction's block, confirm its
   `applied_transactions` row is demoted (`proven: false`, block fields cleared,
   `firstSeenHeight` retained) and the affected `topic_block_anchors` rows now
   carry the canonical block hashes with a recomputed `tac`.
5. Confirm `TAC(topic, tip)` reconverges with peers that observed the same reorg.
6. If the orphaned transaction is re-mined, confirm `/arc-ingest` or
   `refreshUnprovenTransactionProofs` re-proves it and the anchor re-includes it.
   Otherwise confirm `maintainUnprovenTransactions` eventually evicts it as
   unproven.
7. If a provider reports a double spend, confirm the applied transaction is
   evicted immediately and lookup services no longer return it.
