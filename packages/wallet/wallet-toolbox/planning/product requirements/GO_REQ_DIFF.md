# GO_REQ_DIFF.md — go-wallet-toolbox vs UTXO Management Requirements

Compared `bsv_wallet_transaction_requirements.md` (v1.0, May 2026) against `~/git/go/go-wallet-toolbox` (BlockHeaderService era, current main).

Legend: ✅ matches • ⚠️ partial / nuance • ❌ diverges / not implemented

---

## 1. Status Model — ⚠️ Two-table model, +`reorg` extra

Like TS, Go splits status across two tables; requirements doc assumes one.

| Table | Type | Values |
|-------|------|--------|
| `transactions.status` | `wdk.TxStatus` (`pkg/wdk/tx_status.go:11-21`) | `completed`, `failed`, `unprocessed`, `sending`, `unproven`, `unsigned`, `nosend`, `nonfinal`, `unfail` |
| `known_txs.status` | `wdk.ProvenTxReqStatus` (`pkg/wdk/tx_status.go:62-77`) | `sending`, `unsent`, `nosend`, `unknown`, `nonfinal`, `unprocessed`, `unmined`, `callback`, `unconfirmed`, `completed`, `invalidTx`, `doubleSpend`, `unfail`, **`reorg`** |

Notes:
- Go calls it `ProvenTxStatusInvalid = "invalidTx"` (string differs from TS `"invalid"`). Requirements doc uses `"Invalid"`.
- **Extra Go status**: `ProvenTxStatusReorg` (`"reorg"`). Not in requirements. Used as a transient state after reorg detection.
- Broadcast outcome → status mapping (`pkg/storage/internal/actions/process.go:782-810`):

| Aggregated result | `known_tx.status` | `transactions.status` | `spendable` flag |
|------|---|---|---|
| success | `unmined` | `unproven` | `true` |
| doubleSpend | `doubleSpend` | `failed` | `false` |
| invalidTx | `invalidTx` | `failed` | `false` |
| serviceError | `sending` | `sending` | `true` |

**Diff:** Same shape as TS — terminal lifecycle terms live on the KnownTx (ProvenTxReq) side, never on the Transactions table.

---

## 2. `unconfirmed` → `completed` rule (+1 block) — ✅ Enforced via `BlocksDelay`

Requirement §1: `completed` requires Merkle path + ≥1 block on top.

Code (`pkg/defs/sync_tx_statuses.go`):
```go
BlocksDelay: 1   // default
```

`synchronize_tx_statuses.go:91-100` computes `heightForCheck = tipHeight - BlocksDelay`.
`filterTxsByConfirmationDepth` (`synchronize_tx_statuses.go:205-262`) rejects any tx whose `depth < BlocksDelay`. Only txs at sufficient depth proceed to `UpdateKnownTxAsMined`, which sets `known_tx.status = completed` AND `transactions.status = completed` atomically (`pkg/internal/storage/repo/known_tx.go:359-424`).

**This is better than the TS implementation**, which only delays proof solicitation by time (1 min queued header), never a true depth gate. Go enforces the spec.

⚠️ **Caveat for `internalizeAction`** — see §3 below. The depth gate runs only via the periodic sync task. The internalize path bypasses it.

---

## 3. `internalizeAction` — tip vs deep block — ❌ Not differentiated, bypasses depth gate

Requirement §4.1: BEEF with proof → `Completed` if block deep, `Unconfirmed` if block is current tip.

Code (`pkg/storage/internal/actions/internalize.go:235-243`):

```go
if tx.MerklePath != nil {
    if err := in.updateKnownTxAsMined(ctx, userID, txID, tx); err != nil { … }
}
```

`updateKnownTxAsMined` → `KnownTx.UpdateKnownTxAsMined` (`known_tx.go:359-424`) which **unconditionally** sets:
- `KnownTx.Status = ProvenTxStatusCompleted`
- `Transaction.Status = TxStatusCompleted`
- `UserUTXO.UTXOStatus = UTXOStatusMined`

No `tipHeight - blockHeight` check anywhere in the internalize flow. The `BlocksDelay` gate in §2 only applies to the periodic sync task; an incoming BEEF with a proof at the chain tip is immediately marked completed.

---

## 4. `internalizeAction` — discard on broadcast failure — ❌ Doesn't broadcast at all

Requirement §4.2: third-party tx without proof → self-broadcast; if Invalid or fails → discard.

Code: `internalize.go` has **no broadcast call** when `MerklePath == nil`. Flow when no proof in BEEF:
1. `storeNewTx` → `Transaction.Status = TxStatusUnproven`, `KnownTx.Status = ProvenTxStatusUnmined` (`internalize.go:393-397`, `381`)
2. Returns success.

The periodic `SendWaitingTransactions` monitor task picks it up later. If that subsequent broadcast fails, the row stays in storage (no rollback). No "complete discard" semantics for failed third-party broadcasts.

---

## 5. Coinbase 100-block maturity — ❌ Not implemented

`grep -rin "coinbase\|maturity" ~/git/go/go-wallet-toolbox/pkg/` → zero matches.

No offset-0 detection, no 100-block gate on `spendable` / `UTXOStatus`. Same gap as TS.

---

## 6. Reorg → revert Transaction to `unconfirmed` — ⚠️ Partial

Requirement §5: revert to `Unconfirmed`, never `Invalid` or `DoubleSpend`.

Code: Go DOES have reorg event handling (TS effectively does not for the transaction record):
- `pkg/monitor/monitor.go:272-291` — `handleReorgEvents` listens on `OnReorg` channel.
- `pkg/storage/provider.go:1002-1024` — `HandleReorg` invalidates merkle proofs for orphaned block hashes.
- `pkg/internal/storage/repo/known_tx.go:628-694` — `InvalidateMerkleProofsByBlockHash`:
  - Clears `MerklePath`, `BlockHeight`, `BlockHash`, `MerkleRoot`.
  - Sets `KnownTx.Status = ProvenTxStatusReorg`.
  - Resets `attempts = 0`.
  - Adds history note.

`reorg` is in `statusesReadyToSync`, so `CheckForProofsTask` re-fetches a fresh proof on the next cycle.

**Gap:** `InvalidateMerkleProofsByBlockHash` does **not** touch `transactions.status`. If a tx was previously `TxStatusCompleted`, it stays `completed` while the proof is gone. Requirement says revert to `Unconfirmed`. Diff at the Transaction-table level.

Also: there is no Transaction-table value matching "unconfirmed" anyway (see §1), so even a perfect implementation would have to invent a new status or revert to `TxStatusUnproven`.

---

## 7. Sequential broadcast fallback — ❌ Diverges (parallel)

Requirement §3: never broadcast to multiple services simultaneously.

Code (`pkg/services/services.go:529-592`):
```go
efResults, efErr := s.postEFServices.All(ctx, efHex, txID)
txResults, txErr := s.postTXServices.All(ctx, rawTx)
```

`.All` on `Queue` types calls services **in parallel** via `processParallel` (`pkg/services/internal/servicequeue/queues.go:46-50, 91-95`).

Every other service queue method in this file (`MerklePath`, `IsValidRootForHeight`, `ChainHeaderByHeight`, `GetStatusForTxIDs`, `GetUtxoStatus`, `RawTx`, `BSVExchangeRate`, `FindChainTipHeader`, …) uses `OneByOne`. Only the broadcast path is parallel.

**Direct violation of §3.** Worse than TS, which defaults to sequential `UntilSuccess` and offers `PromiseAll` only as a config option.

---

## 8. "Mark Invalid only after all services fail" — ✅ Matches

`pkg/wdk/services_aggregated_postebeef_result.go:43-65` (`summarize`):
```go
switch {
case agg.DoubleSpendCount > 0:  → DoubleSpend
case agg.SuccessCount > 0:       → Success
case agg.ServiceErrorCount > 0:  → ServiceError
default:                          → InvalidTx
}
```

`InvalidTx` requires zero successes, zero doubleSpends, **and** zero service errors. If any provider errored out (network down), result is `ServiceError`, not `InvalidTx`. ✅ Stricter than required.

---

## 9. Mixed broadcast results → trust positive — ❌ Diverges (doubleSpend wins)

Requirement §3: "trust the positive response; log discrepancy; do not mark Invalid unless all reject."

Code (`services_aggregated_postebeef_result.go:55-59`): `doubleSpend > 0` is checked **before** `success > 0`. Mix of `success=1, doubleSpend=1` → classified as `DoubleSpend` → `Transaction.Status = TxStatusFailed`, `KnownTx.Status = doubleSpend`, `spendable = false`.

Compounded by §7: since broadcast is parallel and aggregated, this case is reachable on every run (TS hides it in sequential-with-early-break mode).

---

## 10. Output `spendable=false` on Invalid/DoubleSpend — ⚠️ Partial (different mechanism)

Requirement §6: set `spendable=false` on **all outputs** of the tx; they become toxic.

Code (`process.go:655-682`):
```go
if newTxStatus == wdk.TxStatusFailed {
    // for each linked Transaction row id
    p.outputRepo.RecreateSpentOutputs(ctx, id)
}
…
if spendable {
    p.utxoRepo.CreateUTXOForSpendableOutputsByTxID(ctx, txID)
}
```

`RecreateSpentOutputs` (`pkg/internal/storage/repo/outputs.go:652-693`) only operates on outputs where `SpentBy = spendingTransactionID` — i.e. **inputs this tx consumed**, restoring them to `Spendable = true`. It does **not** walk the tx's own generated outputs and mark them `Spendable = false`.

Why this works in practice in Go: the `UserUTXO` table is a separate index of currently-spendable outputs. `CreateUTXOForSpendableOutputsByTxID` is called **only** on broadcast success. Outputs of a failed tx therefore never get a `UserUTXO` row → they are implicitly excluded from input-selection queries.

**Implicit, not explicit.** Diverges from the literal spec ("set spendable=false on all outputs"). Output rows on the underlying `outputs` table can still have `Spendable=true` from prior speculative setup, with no `UserUTXO` to back them. Safe as long as every input-selection path uses `UserUTXO` and never reads `outputs.spendable` directly.

---

## 11. `unfail` must not modify outputs — ❌ Diverges

Requirement §6: `Status → Unfail` — do not modify outputs.

Code (`pkg/storage/internal/actions/process_unfail.go:101-114`):
```go
func (p *process) markAsUnminedAndUnproven(...) {
    p.knownTxRepo.UpdateKnownTxStatus(... ProvenTxStatusUnmined ...)
    p.txRepo.UpdateTransactionStatusByTxID(... TxStatusUnproven)
    p.utxoRepo.CreateUTXOForSpendableOutputsByTxID(ctx, txID)  // ← writes UTXOs
}
```

Direct write into the UTXO table on every successful unfail. Same direction as TS — both implementations rebuild output state during unfail.

---

## 12. Merkle path validation against local chaintracker — ✅ Matches

`internalize.go:262-291` `updateKnownTxAsMined`:
```go
block := blockHeaderService.ChainHeaderByHeight(ctx, tx.MerklePath.BlockHeight)
root := tx.MerklePath.ComputeRootHex(&txID)
// stored block.Hash and root
```

Computed root is bound to the looked-up header. `synchronize_tx_statuses.go` similarly relies on `s.services.MerklePath(...)` which routes through chain-aware providers. ✅

(Minor: internalize does not explicitly check `IsValidRootForHeight` against the chain tracker — it trusts the header service's height lookup matches the computed root. The `BlockHeaderService` is the chain-of-truth here.)

---

## 13. Atomicity — ✅ Strong

Requirement §8: tx + outputs updated atomically.

Code uses `gorm.DB.Transaction(...)` blocks at every multi-table mutation:
- `UpdateKnownTxAsMined` (`known_tx.go:366`) — KnownTx + Transaction + UserUTXO in one gorm tx.
- `InvalidateMerkleProofsByBlockHash` (`known_tx.go:643`) — proof clear + notes.
- `RecreateSpentOutputs` (`outputs.go:659`) — input release + change UTXO recreation.
- 20+ wrapper points across `pkg/internal/storage/`.

Better atomicity story than TS overall, except for the same `internalize + later-broadcast` gap (§4) where insert and broadcast are not co-transactional.

---

## 14. Audit logging — ✅ Matches

`pkg/internal/storage/history/history_note.go`: `Builder` produces `TxHistoryNote` rows with `What`, `When`, `User`, attributes. Notes added on:
- `InternalizeAction`, `ProcessAction`, `AggregateResults`
- `NotifyTxOfProof`, `GetMerklePathSuccess`, `GetMerklePathNotFound`
- `ReorgInvalidatedProof`
- `PostBeefError` (per-service)

Equivalent to TS `EntityProvenTxReq.history` and persists to a dedicated DB table. ✅

---

## 15. Performance < 100 ms — ⚪ Not measured

Non-functional. No benchmark gate in repo. Out of scope.

---

## 16. ARC-down resilience — ✅ Matches (after caveat)

Multiple services configured (ARC, WoC, BitTails). PostFromBEEF aggregates `.All` results — as long as at least one returns success, the aggregated result is `Success`. ✅

But: the parallel-broadcast violation in §7 means ARC-down detection produces extra load instead of graceful failover.

---

## 17. Monitor task surface — ⚠️ Sparser than TS

Go monitor (`pkg/monitor/all_tasks.go`) wires only 4 tasks:

1. `CheckForProofs` → calls `SynchronizeTransactionStatuses` (depth gate + proof fetch + terminal review).
2. `SendWaiting` → broadcast queued txs.
3. `FailAbandoned` → age out unprocessed txs.
4. `UnFail` → retry `unfail` status txs.

Plus event-driven (not tasks): `OnReorg` channel → `HandleReorg` → `InvalidateMerkleProofsByBlockHash`.

TS has ~17 tasks including `TaskNewHeader` (header queueing), `TaskReorg`, `TaskArcSSE`, `TaskReviewDoubleSpends`, `TaskReviewProvenTxs`, `TaskReviewStatus`, `TaskReviewUtxos`, `TaskCheckNoSends`, `TaskMineBlock`, `TaskPurge`, `TaskSyncWhenIdle`, `TaskMonitorCallHistory`, `TaskClock`.

Go folds CheckNoSends inside the sync task (`statusesWithNoSend` triggered every `CheckNoSendPeriodHours`, default 24h). Reorg is event-pushed rather than polled. No ARC SSE listener. No periodic UTXO consistency review.

**Diff:** Less surveillance, more reliance on event-driven proof updates. Acceptable for `BlockHeaderService` deployments; weaker for chains where reorg events aren't pushed reliably.

---

## Summary table

| § | Requirement | Status | Action |
|---|---|---|---|
| 1 | Status enum | ⚠️ split across 2 tables (+ extra `reorg`) | Doc both tables; align `invalidTx` vs `invalid` casing |
| 2 | `completed` requires +1 block | ✅ via `BlocksDelay` in sync task | — |
| 4.1 | tip vs deep in `internalizeAction` | ❌ always completed if proof present | Apply `BlocksDelay` gate inside `updateKnownTxAsMined` or defer status to sync task |
| 4.2 | discard third-party broadcast failure | ❌ doesn't broadcast at internalize time | Either broadcast inline and rollback on failure, or document the deferred discard semantics |
| 2/5/6 | Coinbase 100-block maturity | ❌ missing | Detect offset==0; gate `UserUTXO` until depth ≥ 100 |
| 5 | Reorg revert Transaction to `unconfirmed` | ⚠️ KnownTx reset only, Tx stays `completed` | Also flip `transactions.status` in `InvalidateMerkleProofsByBlockHash` |
| 3 | Sequential fallback | ❌ `.All` parallel | Switch `postEFServices` / `postTXServices` to `OneByOne` or new sequential helper |
| 3 | Mark Invalid only after all fail | ✅ | — |
| 3 | Mixed results → trust positive | ❌ doubleSpend wins | Reorder `summarize` switch: success first |
| 6 | Outputs → `spendable=false` on Invalid/DoubleSpend | ⚠️ implicit via `UserUTXO` absence | Either explicitly flip `outputs.spendable` or audit every reader to ensure UTXO-only selection |
| 6 | Unfail leaves outputs untouched | ❌ rebuilds `UserUTXO` | Remove `CreateUTXOForSpendableOutputsByTxID` from `markAsUnminedAndUnproven`, or document the behavior diff |
| 4.1 | Merkle path validation | ✅ via header service | — |
| 8 | Atomicity | ✅ except internalize+broadcast gap | Wrap insert+broadcast in single transaction |
| 8 | Audit log | ✅ `TxHistoryNote` table | — |
| 8 | <100 ms perf | ⚪ not measured | Add benchmark |
| 8 | ARC-down resilience | ✅ multiple services | — |
| — | Monitor task surface | ⚠️ 4 tasks vs TS ~17 | Add periodic UTXO consistency / chain-tip-aware reviewers if needed |

---

## TS vs Go side-by-side (key differences)

| Aspect | TS wallet-toolbox | Go wallet-toolbox |
|---|---|---|
| Depth gate for `completed` | ❌ time-only delay (queued header, 1 min) | ✅ block-depth gate (`BlocksDelay` default 1) |
| Reorg → revert Transaction | ❌ explicitly blocked at `StorageProvider:470` | ⚠️ partial — KnownTx → `reorg`, Transaction unchanged |
| Broadcast fallback | ✅ sequential `UntilSuccess` (default) | ❌ parallel `.All` (always) |
| Internalize on broadcast failure | ⚠️ throws `WERR_REVIEW_ACTIONS`, partial rows persist | ❌ doesn't broadcast at internalize time |
| Coinbase maturity | ❌ missing | ❌ missing |
| Atomicity of mined update | ⚠️ multiple updates | ✅ single gorm.Transaction (KnownTx + Tx + UserUTXO) |
| Spendable=false on failed | ⚠️ inputs released only | ⚠️ implicit via UserUTXO absence; explicit `spendable` not flipped |
| Unfail touches outputs | ❌ yes | ❌ yes |
| Monitor task count | ~17 | 4 + reorg event handler |
| Extra status value | — | `reorg` |
| Invalid status string | `"invalid"` | `"invalidTx"` |

---

## Source references (one-stop)

- `pkg/wdk/tx_status.go` — both status enums (incl. `reorg`)
- `pkg/defs/sync_tx_statuses.go` — `BlocksDelay`, `CheckNoSendPeriodHours`, `MaxAttempts`
- `pkg/storage/internal/actions/synchronize_tx_statuses.go` — depth-gated sync, terminal failure review
- `pkg/storage/internal/actions/internalize.go` — internalize flow (no broadcast on missing proof)
- `pkg/storage/internal/actions/process.go:629-810` — broadcast → status mapping
- `pkg/storage/internal/actions/process_unfail.go:80-114` — unfail (touches UTXOs)
- `pkg/wdk/services_aggregated_postebeef_result.go:43-110` — aggregation logic
- `pkg/services/services.go:529-592` — `PostFromBEEF` uses `.All` (parallel)
- `pkg/services/internal/servicequeue/queues.go:46-150` — `All` vs `OneByOne` semantics
- `pkg/monitor/all_tasks.go` — 4 task factories
- `pkg/monitor/monitor.go:272-291` — reorg event handler
- `pkg/storage/provider.go:1002-1024` — `HandleReorg`
- `pkg/internal/storage/repo/known_tx.go:359-424` — `UpdateKnownTxAsMined` (atomic KnownTx + Tx + UserUTXO update)
- `pkg/internal/storage/repo/known_tx.go:628-694` — `InvalidateMerkleProofsByBlockHash`
- `pkg/internal/storage/repo/outputs.go:652-693` — `RecreateSpentOutputs` (inputs only)
