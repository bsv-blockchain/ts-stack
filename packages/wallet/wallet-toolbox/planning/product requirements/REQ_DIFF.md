# REQ_DIFF.md — Wallet Toolbox vs UTXO Management Requirements

Compared `bsv_wallet_transaction_requirements.md` (v1.0, May 2026) against `@bsv/wallet-toolbox` v2.1.24 source.

Legend: ✅ matches • ⚠️ partial / nuance • ❌ diverges / not implemented

---

## 1. Status Model — ⚠️ Two-table model, requirements assume one

Requirements present a single status enum on the Transactions table. Code splits status across **two tables**:

| Table | Type | Values |
|-------|------|--------|
| `transactions.status` | `TransactionStatus` (`src/sdk/types.ts:83`) | `completed`, `failed`, `unprocessed`, `sending`, `unproven`, `unsigned`, `nosend`, `nonfinal`, `unfail` |
| `proven_tx_reqs.status` | `ProvenTxReqStatus` (`src/sdk/types.ts:54`) | `sending`, `unsent`, `nosend`, `unknown`, `nonfinal`, `unprocessed`, `unmined`, `callback`, `unconfirmed`, `completed`, `invalid`, `doubleSpend`, `unfail` |

Lifecycle terms in requirements (`unmined`, `callback`, `unconfirmed`, `invalid`, `doubleSpend`) live on `ProvenTxReq`, not on `transactions`. Mapping observed in `attemptToPostReqsToNetwork.ts:236-254`:

| Broadcast outcome | `req.status` | `tx.status` |
|------|---|---|
| success | `unmined` | `unproven` |
| doubleSpend | `doubleSpend` | `failed` |
| invalidTx | `invalid` | `failed` |
| serviceError | `sending` | `sending` |

**Diff:** Any future req-table change (rename, value adjust) needs to be mirrored against this dual model. Requirements doc should be updated to acknowledge the two tables, OR the code should expose a unified view.

---

## 2. `unconfirmed` → `completed` rule (1 block on top) — ❌ Not enforced

Requirement §1, §2: `completed` requires Merkle path **AND** at least 1 block mined on top.

Code path (`TaskCheckForProofs.ts:111-253`): when proof acquired, `req.status` is set directly to `completed` via `EntityProvenTx.fromReq` + `updateProvenTxReqWithNewProvenTx`. There is no second-stage gate that waits for `tipHeight > proofHeight`.

Closest mitigation: `TaskNewHeader.ts:83-92` queues new headers for one cycle (default 1 minute) before triggering proof solicitation, **and** `TaskCheckForProofs.ts:199` rejects proofs whose `header.height > maxAcceptableHeight` (the queued tip height). This delays proof acquisition but does not require an actual confirmation **on top** — a proof from the tip block is acceptable as soon as it's been the tip for >1 cycle.

**Diff:** Requirement asks for a block-depth gate. Code has a time-delay gate. No `unconfirmed` waiting state in the transaction table. To match, would need a new task that promotes `req.status='unconfirmed'` to `completed` only when `tipHeight - ptx.height >= 1`.

---

## 3. `internalizeAction` — tip vs deep block — ❌ Not differentiated

Requirement §4.1: confirmed incoming tx with proof → `completed` if block deep, `unconfirmed` if block is current tip.

Code (`internalizeAction.ts:287-324`):

```ts
const status: TransactionStatus = (provenTx != null) ? 'completed' : 'unproven'
```

Single branch. No tip-height check. Any incoming BEEF with a valid bump becomes `completed` immediately.

---

## 4. `internalizeAction` — discard on broadcast failure — ❌ Throws instead of discarding

Requirement §4.2: third-party unconfirmed tx whose self-broadcast fails or returns Invalid → **completely discard, do not store**.

Code (`internalizeAction.ts:406-426`): inserts `transactions` and `proven_tx_reqs` rows **before** broadcast (`findOrInsertTargetTransaction`, `getProvenOrReq` happen at lines 387-403). When `shareReqsWithWorld` returns non-success, control returns from `newInternalize()` and `WERR_REVIEW_ACTIONS` is thrown by the caller — but the partially-written rows are **not rolled back**. There is no enclosing `storage.transaction(...)` around the insert + broadcast pair.

**Diff:** "Strict" discard semantics not implemented. Failing third-party broadcasts leave a row with status `unsent` and `tx.status='unproven'`.

---

## 5. Coinbase 100-block maturity — ❌ Not implemented

Requirement §2 note, §5, §6: detect coinbase via merkle offset == 0; outputs remain `spendable=false` until block depth ≥ 100, regardless of tx status.

Search of `src/`: no maturity check. Only mentions of "coinbase":
- `Monitor.ts:491` — comment only, "Coinbase transactions always become invalid" (about reorg, also misleading)
- `MockChain` has an `isCoinbase` flag for test fixtures but does not gate `spendable`

`internalizeAction.ts:452-525` always sets `spendable: true` on inserted wallet payment / basket insertion outputs once the tx is `completed`. No offset-0 detection, no 100-block deferred enable.

---

## 6. Reorg → revert to `unconfirmed` — ❌ Code reproves in place; explicitly forbids un-completing

Requirement §5 reorg rule: revert to `unconfirmed`, never mark `invalid` or `doubleSpend`, wait for new confirmation+1 block.

Code:
- `TaskReorg.ts` + `WalletStorageManager.ts:547-578` (`reproveHeader`): on orphaned block hash, attempts to fetch a fresh merkle path and **update** the `proven_txs` record in place. If unavailable after 3 retries, the proven_txs record is left with the stale data (logged but not invalidated).
- `StorageProvider.ts:470`:
  ```ts
  if ((status !== 'completed' && tx.status === 'completed') || tx.provenTxId) {
    throw new WERR_INVALID_OPERATION('The status of a "completed" transaction cannot be changed.')
  }
  ```
  Hard block on de-completing. A reverting "completed → unconfirmed" path is impossible via `updateTransactionStatus`.

**Diff:** No code path that reverts a transaction's status on reorg. Reorg handling is limited to merkle path repair; spendable values for outputs are not touched on reorg. Requirement §6 ("preserve spendable") is satisfied trivially because nothing flips them, but only because the revert step is missing entirely.

---

## 7. Sequential broadcast fallback — ✅ Default matches, configurable

Requirement §3: sequential, never simultaneous.

Code (`Services.ts:383-433`):
- Default `postBeefMode = 'UntilSuccess'` → `for` loop, breaks on first `success`. ✅
- `'PromiseAll'` mode also exists and would broadcast in parallel. ⚠️ Configurable away from spec.
- Soft timeout (`postBeefUntilSuccessSoftTimeoutMs = 5000`, scales by KiB) per provider — covers "indefinite hang".
- Service that returns `serviceError` is moved to end of list (`moveServiceToLast`) for next cycle.

---

## 8. "Mark Invalid only after all services fail" — ✅ Matches

`aggregatePostBeefResultsByTxid` (`attemptToPostReqsToNetwork.ts:146-175`):

```ts
if (ar.successCount > 0 && ar.doubleSpendCount === 0) ar.status = 'success'
else if (ar.doubleSpendCount > 0) ar.status = 'doubleSpend'
else if (ar.statusErrorCount > 0) ar.status = 'invalidTx'
else ar.status = 'serviceError'
```

`invalidTx` requires zero successes AND zero doubleSpends across all attempted services. ✅

---

## 9. Mixed broadcast results — ❌ Diverges (doubleSpend overrides success)

Requirement §3: "Mixed results (one accepts, another rejects) SHALL be resolved by trusting the positive response."

Code (`attemptToPostReqsToNetwork.ts:169-170`): `doubleSpend > 0` is checked **after** `success > 0 && doubleSpend === 0`. So a `(success=1, doubleSpend=1)` mix is classified as `doubleSpend`, not `success`.

Sequential mode partly hides this — first success breaks the loop before subsequent providers can report doubleSpend. But in `PromiseAll` mode, doubleSpend wins.

**Diff:** Requirement says trust positive; code prefers the more conservative `doubleSpend` outcome on conflict.

---

## 10. Output `spendable` synchronization on terminal status — ⚠️ Partial

Requirement §6: on `Invalid` / `DoubleSpend` set `spendable=false` on **all outputs of the transaction**.

Code (`StorageProvider.ts:474-497`, `updateTransactionStatus` `case 'failed'`):
- Releases this tx's **inputs** back to spendable (`spendable: true`, `spentBy: undefined`). ✅ partial.
- Does **not** explicitly walk the tx's own outputs and force them to `spendable=false`. Relies on those outputs already being `spendable=false` (change outputs created with `spendable: false` at `createAction.ts:920`, then flipped to true elsewhere in the lifecycle).

**Diff:** No explicit defensive flip of generated outputs. If an output was promoted to `spendable=true` (e.g., post-broadcast for change basket) and the tx later flips to `failed`, the output is not retroactively marked toxic by `updateTransactionStatus`. There is no test confirming the "all outputs to spendable=false on failed" invariant.

---

## 11. `unfail` must not modify outputs — ❌ Diverges

Requirement §6: `Status → Unfail` — do not modify the outputs table.

Code (`TaskUnFail.ts:94-144` `unfailReq`):
- Sets `spentBy` and `spendable=false` on inputs that match user outputs (line 123).
- Re-walks the tx's outputs and updates `spendable` based on UTXO check (lines 128-141).

**Diff:** Direct violation. Code rebuilds output state during unfail; requirement says leave outputs untouched.

---

## 12. Merkle path validation against local chaintracks — ✅ Matches

`internalizeAction.ts:274-285` `validateAtomicBeef`: `ab.verify(chainTracker, false)` validates merkle root against chain headers. Failure throws `WERR_INVALID_PARAMETER`, transaction is not persisted. ✅

`TaskCheckForProofs.ts:198-209` for self-created txs likewise validates via `services.getMerklePath` which goes through chaintracks-backed verification.

---

## 13. Atomicity — ✅ Mostly matches

Requirement §8: status + outputs updated atomically or rolled back.

Code:
- `createAction` → `storage.transaction(async trx => ...)` (`createAction.ts:230`). ✅
- `attemptToPostReqsToNetwork` → uses `runAsStorageProvider` and accepts a `trx` param. ✅
- `updateTransactionStatus` → wraps in `this.transaction(...)` (`StorageProvider.ts:457`). ✅
- **Gap:** `internalizeAction` insert + self-broadcast (item 4) is **not** wrapped in a single transaction.

---

## 14. Audit logging — ✅ Matches

Requirement §8: log every status change with timestamp + reason.

Code: `EntityProvenTxReq.history` is a JSON object mutated via `addHistoryNote({ when: ISO timestamp, what: <reason>, ...details })`, persisted on every `updateStorageDynamicProperties`. Notes are added at every aggregation/broadcast/proof-attempt step (e.g. `attemptToPostReqsToNetwork.ts:215-265`). ✅

No equivalent history on the `transactions` table itself, but the linked `proven_tx_reqs` row carries the trail.

---

## 15. Performance < 100 ms — ⚪ Not measured here

Non-functional. No benchmark in repo gates this. Both Knex and IDB backends have batched query patterns, but no SLA test. Out of scope for diff.

---

## 16. Wallet functional with ARC unavailable — ✅ Matches

Default `postBeefServices` registration (`Services.ts:96-110`) registers ARC GorillaPool, ARC Taal, Bitails, WhatsOnChain. Sequential `UntilSuccess` mode walks all four. As long as one provider responds, broadcast succeeds. ✅

---

## Summary table

| § | Requirement | Status | Action |
|---|---|---|---|
| 1 | Status enum | ⚠️ split across 2 tables | Doc both, or unify |
| 2 | `completed` requires +1 block | ❌ time delay only | Add depth gate task |
| 4.1 | tip vs deep distinction in `internalizeAction` | ❌ always `completed` | Branch on `tipHeight - bump.blockHeight` |
| 4.2 | discard third-party broadcast failure | ❌ partial state persists | Wrap insert+broadcast in trx; rollback on failure |
| 2/5/6 | Coinbase 100-block maturity | ❌ missing | Detect offset==0; gate `spendable` until depth ≥ 100 |
| 5 | Reorg revert to `unconfirmed` | ❌ blocked by code | Allow `completed` → `unconfirmed` revert path |
| 3 | Sequential fallback | ✅ default | — |
| 3 | Mark Invalid only after all fail | ✅ | — |
| 3 | Mixed results → trust positive | ❌ doubleSpend wins | Reorder aggregation: success-first |
| 6 | Outputs → `spendable=false` on Invalid/DoubleSpend | ⚠️ inputs only | Add explicit walk over tx outputs in `case 'failed'` |
| 6 | Unfail leaves outputs untouched | ❌ rebuilds output state | Strip output mutation from `TaskUnFail.unfailReq` |
| 4.1 | Merkle path validation | ✅ | — |
| 8 | Atomicity | ⚠️ except `internalizeAction` | Wrap insert+broadcast |
| 8 | Audit log | ✅ on req | Mirror to tx for completeness? |
| 8 | <100 ms perf | ⚪ not measured | Add benchmark |
| 8 | ARC-down resilience | ✅ | — |

---

## Source references (one-stop)

- `src/sdk/types.ts:54-92` — both status enums
- `src/storage/methods/attemptToPostReqsToNetwork.ts:146-281` — broadcast aggregation + status mapping
- `src/services/Services.ts:383-489` — postBeef sequential vs parallel + soft timeout
- `src/storage/methods/createAction.ts:230-924` — output spendable lifecycle
- `src/storage/methods/internalizeAction.ts:274-525` — third-party tx flow
- `src/storage/StorageProvider.ts:429-501` — `updateTransactionsStatus` / `updateTransactionStatus`
- `src/monitor/tasks/TaskCheckForProofs.ts:108-256` — proof acquisition + completed transition
- `src/monitor/tasks/TaskNewHeader.ts:54-95` — queued-header delay
- `src/monitor/tasks/TaskReorg.ts` + `src/storage/WalletStorageManager.ts:547-615` — reorg handling
- `src/monitor/tasks/TaskUnFail.ts:60-148` — unfail flow (outputs touched)
