# BRC-136 BASM Reorg Handling — Design

**Date:** 2026-06-08
**Status:** Approved (design)
**Scope:** `packages/overlays/overlay`, `packages/overlays/overlay-express`. Chaintracks-server changes explicitly out of scope.

## Problem

BRC-136 anchors (`topic_block_anchors`) and the admitted set (`applied_transactions`)
are keyed by `(topic, blockHeight, blockHash)`. When a block is reorged out:

- the proven `applied_transactions` rows for the deactivated block keep their stale
  `blockHash`/`merkleRoot`,
- the anchor for that height keeps committing (via `basmRoot`) to txids that are no
  longer canonical at that height, and
- every `tac` from that height to the tip is derived over the stale block hash.

Result: the topic's Topic Anchor Chain **permanently diverges** from peers that
observed the reorg, even though the admission predicate would now yield a different
set. The engine has no reorg entrypoint today; reorgs are only noticed incidentally
when a *new* proof arrives and `resolveBlockHash` finds a merkle-root mismatch.

## Principle: reuse the existing chaintracks reorg mechanism

The stack already has a reorg propagation mechanism, used by wallet-toolbox. We
mirror it rather than invent a new transport.

- `Chaintracks.insertHeader` detects reorgs internally, computing `reorgDepth` and
  the authoritative **`deactivatedHeaders[]`** (blocks removed from the active
  chain), then calls `notifyReorgListeners`.
  (`packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Chaintracks.ts:414`)
- Consumers register via
  `subscribeReorgs((depth, oldTip, newTip, deactivatedHeaders) => …)`.
  (`ChaintracksClientApi.ts:13`)
- wallet-toolbox `Monitor._init` subscribes; `processReorg` queues the deactivated
  headers; `TaskReorg` calls `storage.reproveHeader(hash)` per deactivated block,
  with retry. (`monitor/Monitor.ts:166,506`, `monitor/tasks/TaskReorg.ts:59`)

The overlay engine consumes the **same in-process event** and reacts with the
overlay analog of "reprove the deactivated block's transactions".

**Known shared limitation (out of scope):** `ChaintracksServiceClient.subscribeReorgs`
throws `Method not implemented` and chaintracks-server exposes no WS/SSE — so the
event path is in-process only for the whole stack today. Implementing a remote event
channel benefits wallet-toolbox and overlay equally and belongs in its own change.
The poll-loop fallback (below) covers event-less deployments in the meantime.

## Architecture

Two trigger paths, one mechanism (`Engine.handleReorg`):

```
[primary]  Chaintracks (in-process) --subscribeReorgs--> Engine listener
                                                              |
                                                              v
[fallback] BASM poll loop --isValidRootForHeight sweep--> Engine.handleReorg
                                                              |
                                                              v
                                  demote stale applied_transactions to unproven
                                                              |
                                                              v
                                  rebuild anchor chain (lowest affected height -> tip)
                                                              |
                                                              v
                                  TAC re-derives over canonical hashes -> reconverges
```

### Component 1 — `Engine.handleReorg`

```ts
async handleReorg(
  deactivatedHeaders: Array<{ hash: string; height: number }>,
  newTipHeight: number
): Promise<ReorgReport>
```

Behavior:
1. If no `findProvenAppliedTransactionsByBlockHash` / anchor storage support, return
   an empty report (BASM not enabled for this storage).
2. For each deactivated header `(hash, height)`:
   - find **proven** `applied_transactions` rows with that `blockHash`,
   - demote each to unproven (Component 3).
   - record `height` as affected, per topic touched.
3. For each affected topic, `rebuildTopicAnchorChain(topic, minAffectedHeight,
   newTipHeight, canonicalHashHints)`. `basmRoot` now reflects the surviving admitted
   set; `tac` re-chains over canonical block hashes from the resolver.
4. Return `{ perTopic: { topic, affectedHeights, demotedTxids, rebuiltFrom } }`.

Idempotent: a clean input (no proven rows for the given hashes) demotes nothing and
rebuilds an identical TAC. Safe to invoke repeatedly.

### Component 2 — event subscription (engine wiring)

- The engine accepts an optional event-capable chaintracks handle (duck-typed:
  has `subscribeReorgs`), mirroring `Monitor.chaintracksWithEvents`.
- On engine start, if present, subscribe and route events:
  `subscribeReorgs((depth, oldTip, newTip, deactivated) =>
     handleReorg(deactivated.map(h => ({hash: h.hash, height: h.height})), newTip.height))`.
- Listener errors are swallowed/logged (matches `notifyReorgListeners` contract).

### Component 3 — fallback poll sweep (event-less chain trackers)

For chain trackers without `subscribeReorgs` (e.g. `WhatsOnChain`, remote
`ChaintracksServiceClient`):

- The existing BASM poll loop (`OverlayExpress.advanceBASMAnchorChains`, every
  `basmBlockPollIntervalMs`) also calls a revalidation sweep.
- Sweep: for proven `applied_transactions` rows in `[tip - reorgScanDepth + 1, tip]`
  (default `reorgScanDepth = 3`, configurable), check
  `chainTracker.isValidRootForHeight(row.merkleRoot, row.blockHeight)` and compare
  `row.blockHash` to the resolver's canonical hash. Any mismatch ⇒ treat that
  `blockHash` as deactivated and feed it into `handleReorg`.
- This recovers reorgs for every chain-tracker type, with poll-interval latency.

### Component 4 — storage additions (Knex)

- `findProvenAppliedTransactionsByBlockHash(blockHash): Promise<Array<{ txid; topic; blockHeight }>>`
- `findProvenAppliedTransactionsInRange(fromHeight, toHeight, topic?): Promise<Array<{ txid; topic; blockHeight; blockHash; merkleRoot }>>` (for the fallback sweep)
- `demoteAppliedTransactionToUnproven(txid, topic)`: set `proven=false`, null
  `blockHeight/blockHash/blockIndex/merkleRoot`, **keep `firstSeenHeight`**, and null
  the corresponding `outputs.blockHeight`.

All new storage methods are optional on the interface (BASM is already optional),
so non-BASM storage backends are unaffected.

## Demoted-transaction lifecycle

A demoted row is exactly the "received but unproven" state the engine already
understands:
- **Re-mined** ⇒ `/arc-ingest` → `handleNewMerkleProof` re-proves it at its new
  height; the anchor includes it again. (Overlay analog of `reproveHeader`.)
- **Never re-mined** ⇒ existing `evictUnprovenTransactions` removes it after the
  unproven threshold.

The "we received and admitted this token" record (the unproven row) survives until
one of those resolves — consistent with the receipt-vs-lookup separation documented
in `packages/overlays/overlay/docs/BRC-136-BASM.md`.

## Error handling

- Event listener throwing ⇒ caught + logged; never breaks chaintracks notification.
- `'scripts only'` chain tracker ⇒ fallback sweep is skipped with a warning (cannot
  validate roots); event path still works if a chaintracks handle is wired.
- Resolver returns `undefined` for a height during rebuild ⇒ `rebuildTopicAnchorChain`
  halts at that height (existing behavior) and logs; no partial/gapped chain.
- Re-entrancy: a reorg arriving mid-rebuild is handled on the next event/poll
  because `handleReorg` is idempotent and always rebuilds to the current tip.

## Testing

Extend `packages/overlays/overlay/src/__tests/BASMChain.test.ts` FakeStore plus a
mock `ChainTracker` and header resolver:

1. **Demote + rebuild:** a proven tx whose `blockHash` is in `deactivatedHeaders` is
   demoted; `basmRoot` at that height drops the txid and the tip `tac` changes.
2. **Valid untouched:** proven rows for non-deactivated hashes are left proven.
3. **Idempotency:** `handleReorg` with hashes that match no proven rows ⇒ no change,
   identical TAC.
4. **Re-prove restores:** demote, then `handleNewMerkleProof` at the new height ⇒
   anchor includes the tx again.
5. **Fallback sweep:** a stale root (mock `isValidRootForHeight` returns false) within
   the depth-3 window is detected and routed into `handleReorg`; rows outside the
   window are untouched.
6. **Event wiring (light):** a fake event-capable chaintracks fires `subscribeReorgs`;
   the engine calls `handleReorg` with the mapped headers.

No conformance-vector changes: BRC-136 defines no reorg wire format; reorg recovery
is a local correctness behavior. Documented, not vectorized.

## Documentation

Add a "Reorg handling" section to `packages/overlays/overlay/docs/BRC-136-BASM.md`:
chaintracks as the reorg authority, the shared `subscribeReorgs` mechanism (same as
wallet-toolbox Monitor), the demote-and-rebuild flow, the poll fallback, the
reconvergence guarantee, and operator verification steps (TAC reconverges; the
unproven receipt record persists until re-mine or eviction).

## Out of scope

- Remote chaintracks event transport (WS/SSE + `ChaintracksServiceClient.subscribeReorgs`).
  Shared follow-up that serves wallet-toolbox and overlay.
- Any chaintracks-server modification.
- New `/admin/reorg` HTTP webhook (explicitly rejected — reuses the in-process event).
