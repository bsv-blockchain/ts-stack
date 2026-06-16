---
id: brc136-basm-reorg-handling-design
title: BRC-136 BASM Reorg Handling — Design
kind: spec
domain: overlays
version: 1.0.0
last_updated: "2026-06-08"
last_verified: "2026-06-08"
status: experimental
tags:
  - brc-136
  - basm
  - reorg
  - overlays
  - chaintracks
---

# BRC-136 BASM Reorg Handling — Design

**Date:** 2026-06-08
**Status:** Approved (design), revised for Arcade/go-chaintracks SSE compatibility
**Scope:** `packages/overlays/overlay`, `packages/overlays/overlay-express`. No chaintracks-server / go-chaintracks / Arcade changes — we consume their existing SSE.

## Problem

BRC-136 anchors (`topic_block_anchors`) and the admitted set (`applied_transactions`)
are keyed by `(topic, blockHeight, blockHash)`. When a block is reorged out:

- the proven `applied_transactions` rows for the orphaned block keep their stale
  `blockHash`/`merkleRoot`,
- the anchor for that height keeps committing (via `basmRoot`) to txids that are no
  longer canonical at that height, and
- every `tac` from that height to the tip is derived over the stale block hash.

Result: the topic's Topic Anchor Chain **permanently diverges** from peers that
observed the reorg, even though the admission predicate would now yield a different
set. The engine has no reorg entrypoint today; reorgs are only noticed incidentally
when a *new* proof arrives and `resolveBlockHash` finds a merkle-root mismatch.

## Reorg sources — Arcade SSE is the production authority

The production chain tracker is **Arcade**, which wraps **go-chaintracks**. We
consume its existing reorg stream rather than invent a transport.

### Primary: go-chaintracks `/v2/reorg/stream` (SSE)

`GET /v2/reorg/stream` emits `data: <JSON>\n\n` frames (no `event:` or `id:` lines;
`: keepalive` comment frames between events). The JSON is `chaintracks.ReorgEvent`:

```go
type ReorgEvent struct {
	OrphanedHashes []chainhash.Hash `json:"orphanedHashes"`
	CommonAncestor *BlockHeader     `json:"commonAncestor"`
	NewTip         *BlockHeader     `json:"newTip"`
	Depth          uint32           `json:"depth"`
}
type BlockHeader struct {
	*block.Header                   // version, prevBlock, merkleRoot, time, bits, nonce
	Height uint32         `json:"height"`
	Hash   chainhash.Hash `json:"hash"`
}
```

go-chaintracks' interface also embeds the go-sdk `ChainTracker`
(`isValidRootForHeight`, `currentHeight`), so the same service answers root checks.

Mapping to our mechanism is direct:
- `orphanedHashes` → the block hashes whose admitted rows must be demoted,
- `commonAncestor.height + 1` → anchor-rebuild lower bound,
- `newTip.height` → anchor-rebuild upper bound,
- `depth` → sanity/logging.

**No `id:` lines ⇒ no `Last-Event-ID` replay.** Any reorg that fires while the SSE
client is disconnected is lost. On (re)connect we therefore run a bounded catch-up
sweep (see Component 3) so a missed event still self-heals.

### Secondary (in-process): wallet-toolbox `Chaintracks.subscribeReorgs`

For deployments that embed the TypeScript Chaintracks in-process, the same mechanism
is reached via `subscribeReorgs((depth, oldTip, newTip, deactivatedHeaders) => …)`
(`packages/wallet/wallet-toolbox/src/services/chaintracker/chaintracks/Chaintracks.ts:414`,
mirrored by `Monitor._init` → `TaskReorg` → `reproveHeader`). This is an alternate
adapter feeding the same `handleReorg`.

### Fallback (no reorg events): poll sweep

For chain trackers exposing neither stream (e.g. `WhatsOnChain`), a timer-driven
revalidation sweep detects reorgs with poll-interval latency.

All three sources **normalize to one engine method**, `Engine.handleReorg`.

## Architecture

```
[primary]   Arcade/go-chaintracks  --SSE /v2/reorg/stream--> ReorgSseAdapter
            (ReorgEvent JSON)                                     |
[secondary] in-process Chaintracks --subscribeReorgs-------> ReorgEventAdapter
            (deactivatedHeaders)                                  |
[fallback]  BASM poll loop / SSE reconnect --isValidRootForHeight sweep--> ReorgSweep
                                                                  |
                                                                  v
                                            Engine.handleReorg({ orphanedBlockHashes,
                                                       rebuildFromHeight, newTipHeight })
                                                                  |
                                            demote stale applied_transactions -> unproven
                                                                  |
                                            rebuild anchor chain (rebuildFromHeight -> tip)
                                                                  |
                                            TAC re-derives over canonical hashes -> reconverges
```

### Component 1 — `Engine.handleReorg` (transport-agnostic mechanism)

```ts
async handleReorg(input: {
  orphanedBlockHashes: string[]   // display-hex, normalized
  rebuildFromHeight: number       // commonAncestor.height + 1 (or lowest stale height)
  newTipHeight: number
}): Promise<ReorgReport>
```

Behavior:
1. If BASM storage support is absent, return an empty report (no-op).
2. For each hash in `orphanedBlockHashes`: find **proven** `applied_transactions`
   rows with that `blockHash`; demote each to unproven (Component 4). Collect the
   set of `(topic)` touched.
3. For each touched topic: `rebuildTopicAnchorChain(topic, rebuildFromHeight,
   newTipHeight, canonicalHashHints)`. `basmRoot` now reflects the surviving admitted
   set; `tac` re-chains over canonical block hashes from the header resolver.
4. Return `{ perTopic: { topic, demotedTxids, rebuiltFrom, rebuiltTo } }`.

Idempotent: hashes matching no proven rows demote nothing and the rebuild reproduces
an identical TAC. Safe to invoke repeatedly (every SSE event, reconnect, and poll).

**Hash normalization:** go-sdk `chainhash.Hash` JSON-marshals as reversed (display)
hex. The overlay stores `blockHash` as display hex from its header resolver. The
adapter MUST normalize (lowercase, confirmed byte-order) before equality matching —
verified against a live `ReorgEvent` during implementation.

### Component 2 — reorg adapters (overlay-express wiring)

- **`ReorgSseAdapter`** (primary): an SSE client (e.g. `eventsource`/`undici`) that
  connects to the configured `reorgStreamUrl` (Arcade/go-chaintracks
  `/v2/reorg/stream`), parses each `data:` frame as `ReorgEvent`, maps to
  `handleReorg({ orphanedBlockHashes: orphanedHashes, rebuildFromHeight:
  commonAncestor.height + 1, newTipHeight: newTip.height })`. On connect/reconnect it
  first triggers a catch-up sweep (Component 3). Auto-reconnect with backoff.
- **`ReorgEventAdapter`** (secondary): if the configured chain tracker is event-capable
  (duck-typed `subscribeReorgs`, like `Monitor.chaintracksWithEvents`), subscribe and
  map `deactivatedHeaders.map(h => h.hash)` + `min(height)` + `newTip.height`.
- Both are optional and config-driven; at most one is active. Listener/stream errors
  are caught + logged and never crash the engine.

### Component 3 — revalidation sweep (fallback + reconnect catch-up)

For event-less chain trackers, and on every SSE (re)connect:

- For proven `applied_transactions` rows in `[tip - reorgScanDepth + 1, tip]`
  (default `reorgScanDepth = 3`, configurable), check
  `chainTracker.isValidRootForHeight(row.merkleRoot, row.blockHeight)` and compare
  `row.blockHash` to the resolver's canonical hash. Each mismatch contributes its
  `blockHash` to `orphanedBlockHashes` and its height to the rebuild lower bound.
- Feed the derived set into `handleReorg`.
- In the BASM poll loop this runs every `basmBlockPollIntervalMs`; as reconnect
  catch-up it runs once per connect.

### Component 4 — storage additions (Knex, all optional on the interface)

- `findProvenAppliedTransactionsByBlockHash(blockHash): Promise<Array<{ txid; topic; blockHeight }>>`
- `findProvenAppliedTransactionsInRange(fromHeight, toHeight, topic?): Promise<Array<{ txid; topic; blockHeight; blockHash; merkleRoot }>>` (sweep)
- `demoteAppliedTransactionToUnproven(txid, topic)`: `proven=false`, null
  `blockHeight/blockHash/blockIndex/merkleRoot`, **keep `firstSeenHeight`**, null the
  corresponding `outputs.blockHeight`.

## Demoted-transaction lifecycle

A demoted row is the "received but unproven" state the engine already understands:
- **Re-mined** ⇒ Arcade/ARC re-notifies → `/arc-ingest` → `handleNewMerkleProof`
  re-proves it at its new height; the anchor includes it again. (Overlay analog of
  `reproveHeader`.)
- **Never re-mined** ⇒ existing `evictUnprovenTransactions` removes it after the
  unproven threshold.

The "we received and admitted this token" record (the unproven row) survives until
one of those resolves — consistent with the receipt-vs-lookup separation documented
in `packages/overlays/overlay/docs/BRC-136-BASM.md`.

## Error handling

- SSE frame parse failure / malformed `ReorgEvent` ⇒ log + skip that frame; stream
  continues.
- SSE disconnect ⇒ auto-reconnect with backoff; on reconnect run catch-up sweep
  (covers the no-replay gap).
- Adapter callback throwing ⇒ caught + logged; never breaks the stream/notification.
- `'scripts only'` chain tracker ⇒ sweep skipped with a warning (cannot validate
  roots); SSE adapter still works if `reorgStreamUrl` is configured.
- Resolver returns `undefined` for a height during rebuild ⇒ `rebuildTopicAnchorChain`
  halts at that height (existing behavior) + logs; no gapped chain.
- Re-entrancy: a reorg during a rebuild is handled on the next event/sweep because
  `handleReorg` is idempotent and always rebuilds to the current tip.

## Testing

Extend `packages/overlays/overlay/src/__tests/BASMChain.test.ts` FakeStore plus a
mock chain tracker / header resolver:

1. **Demote + rebuild:** a proven tx whose `blockHash` ∈ `orphanedBlockHashes` is
   demoted; `basmRoot` at that height drops the txid and the tip `tac` changes.
2. **Valid untouched:** proven rows for non-orphaned hashes stay proven.
3. **Idempotency:** `handleReorg` with hashes matching no proven rows ⇒ no change.
4. **Re-prove restores:** demote, then `handleNewMerkleProof` at the new height ⇒
   anchor includes the tx again.
5. **Sweep:** a stale root (mock `isValidRootForHeight` → false) within the depth-3
   window is detected and routed into `handleReorg`; out-of-window rows untouched.
6. **SSE adapter (unit):** feed a captured `ReorgEvent` JSON frame; assert correct
   mapping to `handleReorg` args incl. hash normalization and `commonAncestor.height + 1`.
7. **Reconnect catch-up:** simulated reconnect triggers one sweep.

No conformance-vector changes: BRC-136 defines no reorg wire format; reorg recovery
is local correctness behavior. The `/v2/reorg/stream` shape belongs to go-chaintracks,
not BRC-136.

## Documentation

Add a "Reorg handling" section to `packages/overlays/overlay/docs/BRC-136-BASM.md`:
Arcade/go-chaintracks `/v2/reorg/stream` as the reorg authority (with the `ReorgEvent`
shape), the secondary in-process adapter, the sweep fallback + reconnect catch-up, the
demote-and-rebuild flow, the reconvergence guarantee, and operator verification steps
(TAC reconverges; the unproven receipt record persists until re-mine or eviction).

## Configuration

- `reorgStreamUrl?` — Arcade/go-chaintracks `/v2/reorg/stream` URL. When set, the SSE
  adapter is the primary trigger.
- `reorgScanDepth` — sweep window depth from tip (default `3`).
- Existing `basmBlockPollIntervalMs` drives the periodic sweep.

## Out of scope

- Any change to Arcade, go-chaintracks, or chaintracks-server (we consume existing SSE).
- Implementing `ChaintracksServiceClient.subscribeReorgs` (TS in-process remote client
  WS/SSE) in wallet-toolbox — separate shared follow-up; not needed since the overlay
  consumes go-chaintracks `/v2/reorg/stream` directly.
- A custom `/admin/reorg` HTTP webhook (explicitly rejected — reuses existing SSE).
