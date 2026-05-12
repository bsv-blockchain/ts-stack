# V7 Storage Method Wiring Analysis

Scope: legacy storage methods in `src/storage/methods/{createAction,processAction,internalizeAction,listActionsKnex,listOutputsKnex,attemptToPostReqsToNetwork}.ts` against the V7TransactionService surface in `src/storage/schema/v7Service.ts` and the post-cutover layout established by `src/storage/schema/v7Cutover.ts`.

Approach: static read-through of each method's table touches; cross-reference with V7Service public API; identify gaps.

---

## 1. Post-cutover layout (recap)

After `runV7Cutover`:
- `transactions` is the V7 table (was `transactions_v7`) — columns: `transactionId, txid, processing, processingChangedAt, nextActionAt, attempts, rebroadcastCycles, wasBroadcast, idempotencyKey, batch, rawTx, inputBeef, height, merkleIndex, merklePath, merkleRoot, blockHash, isCoinbase, lastProvider, lastProviderStatus, frozenReason, rowVersion, created_at, updated_at`.
- `actions` holds per-user view: `actionId, userId, transactionId(→transactions), reference, description, isOutgoing, satoshisDelta, userNosend, hidden, userAborted, notifyJson, rowVersion`.
- `tx_labels_map.transactionId` now FKs `actions.actionId` (not transactions). Critical: legacy code paths joining `tx_labels_map.transactionId = transactions.transactionId` are broken post-cutover.
- `transactions_legacy`, `proven_txs_legacy`, `proven_tx_reqs_legacy` retain old data, off the hot path.
- `outputs.transactionId` / `outputs.spentBy` / `commissions.transactionId` are remapped to V7 IDs but the columns still point at the new `transactions` table — same shape, different meaning.

Implication: any method still reading legacy fields (`status, satoshis, isOutgoing, description, version, lockTime, reference, userId, inputBEEF, provenTxId`) directly from `transactions` will break — those columns are gone. Everything user-scoped now lives in `actions`. Every status/FSM concern now lives in `transactions.processing` (ProcessingStatus, not TransactionStatus).

---

## 2. Per-method table/field access map

### `createAction.ts`

| Operation | Legacy SQL pattern | Post-cutover state | V7 replacement |
|---|---|---|---|
| `storage.insertTransaction(newTx)` with legacy fields | `INSERT transactions(...)` | most columns gone except `txid, rawTx, inputBeef` | `V7TransactionService.create({txid, processing:'queued', rawTx, inputBeef})` + `createAction({userId, transactionId, reference, description, isOutgoing, satoshisDelta:0})`. **Gap: at this stage `txid` is unknown — V7 requires it as natural key.** |
| `storage.updateTransaction(id, {satoshis})` | `UPDATE transactions SET satoshis=?` | column absent | Update `actions.satoshisDelta`. **Gap: `updateActionSatoshisDelta`.** |
| `storage.findOrInsertTxLabelMap(transactionId, labelId)` | `INSERT tx_labels_map(transactionId, txLabelId)` | `transactionId` column FKs `actions.actionId` | Pass `actionId`, not `transactionId`. Shim required. |
| outputs / commissions / output_baskets writes | unchanged | unchanged | No change. |
| `getBeefForTransaction`, `getRawTxOfKnownValidTransaction`, `getProvenOrRawTx` | reads `proven_txs`/`proven_tx_reqs` | both `_legacy` | New path reads `rawTx, merklePath, height, blockHash` from V7 `transactions`. |

### `processAction.ts`

| Operation | Legacy | Post-cutover | V7 replacement |
|---|---|---|---|
| `findTransactions({userId, reference})` | SELECT on legacy table | columns absent | **Gap: `findActionByReference(userId, reference)`** |
| read `transaction.{status, isOutgoing, inputBEEF, transactionId}` | legacy columns | gone | resolve via `findAction` + `findById`. `status` derived from `processing`. |
| `EntityProvenTxReq.insertOrMerge` | writes `proven_tx_reqs` | `_legacy` | **Gap.** Funnel into `V7TransactionService.create` or `transition` with rawTx/inputBeef. |
| `updateProvenTxReq(ids, {status, batch})` | `_legacy` | gone | **Gap: `transitionMany` + `setBatch`.** |
| `updateTransaction(ids, {status})` | column gone | gone | **Gap: `transitionMany`.** Bulk variant. |
| `getReqsAndBeefToShareWithWorld` | joins `proven_tx_reqs`+`proven_txs` | both `_legacy` | **Gap: `collectReqsAndBeef(txids)`** rebuilt on V7. |
| `attemptToPostReqsToNetwork` | uses `EntityProvenTxReq` | underlying table renamed | Whole path needs reframing. |
| `findCommissions` | unchanged | unchanged | No change. |

`ReqTxStatus` tuples from `determineReqTxStatus` are the central FSM gap (see §4).

### `internalizeAction.ts`

| Operation | Legacy | Post-cutover | V7 replacement |
|---|---|---|---|
| `findTransactions({userId, txid})` | SELECT | join required | **Gap: `findActionByUserTxid(userId, txid)`** |
| `findOrInsertTransaction(newTx)` | INSERT/UPSERT legacy | columns gone | **Gap: `findOrCreateActionForTxid(args)`** — upsert on transactions by txid + upsert on actions by (userId, transactionId). |
| `updateTransaction(id, {satoshis, provenTxId, status})` | columns gone | split needed | **Gap: `updateActionSatoshisDelta`** + use `recordProof` for proven case. |
| `findOrInsertProvenTx({height, index, merklePath, ...})` | INSERT `proven_txs` | `_legacy` | `recordProof({transactionId, height, ...})`. **Gap: row may not exist yet** — need `createWithProof(args)` shortcut. |
| `getProvenOrReq(txid, ...)` | reads `proven_txs` + `proven_tx_reqs` | `_legacy` | **Gap: `findOrCreateForBroadcast({txid, rawTx, inputBeef})`** returning `{isNew, transaction}`. |
| tx_labels / output writes | unchanged | unchanged | Label map: pass `actionId`. |

### `listActionsKnex.ts`

| Operation | Legacy | Post-cutover | V7 replacement |
|---|---|---|---|
| `SELECT … FROM transactions WHERE userId=? AND status IN (…)` (CTE + main) | columns scattered | post-cutover: `transactions` has `txid, created_at, transactionId`; per-user fields on `actions`; status is `transactions.processing`; `satoshis → actions.satoshisDelta`; `version, lockTime` are NOT stored at all on V7 | **Gap: `listActionsForUser({userId, statusFilter, labelIds, queryMode, createdAtRange, limit, offset})`** JOINing `actions ⨝ transactions` and optionally `tx_labels_map`. Status filter maps from `TransactionStatus → ProcessingStatus`. **`version`/`lockTime` lost on V7** — reconstruct from `rawTx` parsing or restore as columns. |
| `tx_labels_map.transactionId IN labelIds` | now `actionId` | join via `actions` first | Keep raw SQL using `actionId` or wrap in `findActionsByLabelIds`. |
| `getLabelsForTransactionId(tx.transactionId)` | reads `tx_labels_map` by transactionId | now means actionId | **Gap: `getLabelsForAction(actionId)`** or rename helper. |
| `getRawTxOfKnownValidTransaction(tx.txid)` | reads `proven_txs`/`proven_tx_reqs` | `_legacy` | Use `V7TransactionService.findById(id).rawTx` directly. |

### `listOutputsKnex.ts`

| Operation | Legacy | Post-cutover | V7 replacement |
|---|---|---|---|
| Join `outputs o ⨝ transactions t` then `WHERE t.status IN ('completed','unproven','nosend','sending')` | column gone | filter on `transactions.processing` with mapped ProcessingStatus set | **Gap: change WHERE to `t.processing IN (...)`** or expose `listOutputsForUser`. |
| Label enrichment via `tx_labels_map.transactionId IN (output.transactionId)` | `tx_labels_map.transactionId` is `actionId`, `outputs.transactionId` is `transactions.transactionId` — different keyspaces | **Critical break.** | Add `outputs → actions → tx_labels_map` hop. **Gap: `getLabelsByOutputIds(outputIds, userId)`**. |
| `output_tags` / `output_tags_map` | unchanged | unchanged | No change. |

### `attemptToPostReqsToNetwork.ts`

| Operation | Legacy | Post-cutover | V7 replacement |
|---|---|---|---|
| All `EntityProvenTxReq` fields | `proven_tx_reqs` | `_legacy` | Every field migrates to V7 `transactions`: rawTx→`rawTx`, inputBEEF→`inputBeef`, attempts→`attempts`, status→`processing`, wasBroadcast→`wasBroadcast`, batch→`batch`. History notes need `tx_audit` entries. **Gap: `recordSendAttempt`, `recordBroadcastResult`, `recordHistoryNote`, `setBatch`, `incrementAttempts`, `loadForSend(txid[])`.** |
| `mergeReqToBeefToShareExternally` | reads `proven_txs`+`proven_tx_reqs` | `_legacy` | **Gap: `mergeBeefForTxids(beef, txids)`** that reads from V7 `transactions`. |
| `updateTransactionsStatus(ids, newTxStatus)` | mass status update + outputs side-effect | column gone | **Gap: `transitionMany`**. Outputs-spendable side-effect splits out — keep V7 service pure. |
| `findTransactions({transactionId})` in `markStaleInputsAsSpent` | resolves `userId` | only need `userId` | **`findUserIdForTransactionId(transactionId)`** shim. |
| `findOutputsByOutpoints`, `updateOutput`, `validateOutputScript`, `services.isUtxo` | unchanged | unchanged | No change. |

---

## 3. Net-new V7TransactionService methods

Total: **15** net-new methods (+2 small shims).

| # | Signature | Replaces | Complexity |
|---|---|---|---|
| 1 | `findActionByReference(userId, reference): Promise<{action, transaction} \| undefined>` | processAction validation | S |
| 2 | `findActionByUserTxid(userId, txid): Promise<{action, transaction} \| undefined>` | internalizeAction.asyncSetup | S |
| 3 | `findOrCreateActionForTxid(args): Promise<{action, transaction, isNew}>` | internalizeAction.findOrInsertTargetTransaction | M |
| 4 | `updateActionSatoshisDelta(actionId, delta, now?): Promise<void>` | createAction + internalizeAction | S |
| 5 | `createWithProof(args): Promise<TableTransactionV7>` | internalizeAction.newInternalize (bump present) | M |
| 6 | `findOrCreateForBroadcast({txid, rawTx, inputBeef, notifyActionIds}): Promise<{transaction, isNew}>` | internalizeAction.getProvenOrReq | M |
| 7 | `transitionMany({transactionIds, expectedFrom?, to, provider?, providerStatus?, details?}): Promise<{updated, skipped}>` | processAction.shareReqsWithWorld + updateReqsFromAggregateResults | M |
| 8 | `setBatch(transactionIds, batch \| undefined): Promise<void>` | processAction | S |
| 9 | `incrementAttempts(transactionId, now?): Promise<TableTransactionV7 \| undefined>` | attemptToPostReqsToNetwork validate + serviceError | S |
| 10 | `recordBroadcastResult({transactionId, txid, status, provider, providerStatus, wasBroadcast?, details?}): Promise<TableTransactionV7 \| undefined>` | composite of req.status/req.wasBroadcast/history-note writes | M |
| 11 | `recordHistoryNote(transactionId, note): Promise<void>` | `req.addHistoryNote` everywhere — writes a `tx_audit` row | S |
| 12 | `mergeBeefForTxids(beef, txids): Promise<void>` | `mergeReqToBeefToShareExternally` + part of `getReqsAndBeefToShareWithWorld` | M |
| 13 | `collectReqsAndBeef(txids, extraTxids?): Promise<{beef, details}>` | processAction.shareReqsWithWorld | L (carries `readyToSend`/`alreadySent`/`error`/`unknown` classification) |
| 14 | `listActionsForUser({userId, statusFilter?, labelIds?, labelQueryMode?, createdAtFrom?, createdAtTo?, limit, offset, columns?}): Promise<{rows, total?}>` | listActionsKnex CTE-based query | L |
| 15 | `listOutputsForUser({userId, basketId?, tagIds?, tagQueryMode?, processingFilter, includeSpent, limit, offset, includeLockingScripts?})` | listOutputsKnex JOIN+CTE | L |

Shims (in StorageKnex compat layer or service surface):
- `actionIdFromTransactionId(userId, transactionId)` — for `tx_labels_map` writes.
- `getUserIdForTransactionId(transactionId)` — for `attemptToPostReqsToNetwork.markStaleInputsAsSpent`.

---

## 4. FSM transition coverage gaps

`V7TransactionService.transition` already takes any `(from, to)` and defers to the FSM. Wiring needs a complete `legacyReqStatus + legacyTxStatus` → `ProcessingStatus` mapping. Triggers:

| Trigger site | Legacy `req → tx` | V7 `ProcessingStatus` |
|---|---|---|
| processAction / `isNoSend && !isSendWith` | `nosend → nosend` | `queued → nosend` |
| processAction / `!isNoSend && isDelayed` | `unsent → unprocessed` | `queued → queued` (collapses; disambiguate via `nextActionAt`) |
| processAction / `!isNoSend && !isDelayed` (pre) | `unprocessed → unprocessed` | `queued → broadcasting` |
| processAction / `!isNoSend && !isDelayed` (post) | `unmined → unproven` | `broadcasting → broadcasted` |
| internalizeAction / bump present | `(none) → completed` | `(new) → proven` via `recordProof`/`createWithProof` |
| internalizeAction / bump absent | `unsent → unproven` | `queued → broadcasted` |
| attemptToPostReqsToNetwork / `invalid` | `* → invalid` | `* → invalid` |
| attemptToPostReqsToNetwork / `success` | `* → unmined`, tx `* → unproven`, `wasBroadcast=true` | `* → broadcasted` with `wasBroadcast=true` |
| attemptToPostReqsToNetwork / `doubleSpend` | `* → doubleSpend`, tx `* → failed` | `* → doubleSpend` (terminal) |
| attemptToPostReqsToNetwork / `invalidTx` | `* → invalid`, tx `* → failed` | `* → invalid` |
| attemptToPostReqsToNetwork / `serviceError` | `* → sending` + attempts++ | `* → sending` + `incrementAttempts` |
| Monitor proof | `* → completed`, proven | `* → proven` (covered by `recordProof`) |

Audit: FSM table in `v7Fsm` must accept `queued → nosend`, `queued → broadcasting`, `broadcasting → broadcasted`, `broadcasting → doubleSpend`, `broadcasting → invalid`, `sending → broadcasting` (retry). Verify before wiring proceeds. ~1 day to extend FSM + add audit tests.

---

## 5. Recommended sequencing

Argument: lowest blast radius first, validate V7 abstraction, graduate to high-traffic FSM-heavy methods.

| Order | Method | Why |
|---|---|---|
| 1 | **`listOutputsKnex.ts`** (status filter swap + label-join repair) | Read-only, highest call frequency. Validates `listOutputsForUser` API shape + ProcessingStatus mapping. Zero FSM concerns. Fast revert. |
| 2 | **`listActionsKnex.ts`** | Read-only. Establishes `actions ⨝ transactions ⨝ tx_labels_map` shape every other method reuses. Surfaces `version`/`lockTime` data loss early. |
| 3 | **`createAction.ts`** | Forces resolution of `(reference, txid)` ordering — V7 demands txid up front, createAction allocates before txid is known. Unblocks all write-path migrations. |
| 4 | **`processAction.ts`** | Brings FSM in. Validates `transitionMany`, `setBatch`, `findActionByReference`, `collectReqsAndBeef`. Highest-risk but highest-coverage. |
| 5 | **`attemptToPostReqsToNetwork.ts`** | Heaviest legacy-entity coupling. Mechanical after processAction proves V7 handles batched FSM + history notes. |
| 6 | **`internalizeAction.ts`** | Lowest call frequency, highest branching. Validate everything else first; internalize reuses mature primitives. |

Pilot: wire `listOutputsKnex.ts` first (1 day) — pure read-side, exercises ProcessingStatus + actions/transactions join + label keyspace change in one low-risk change. Validates V7 API shape for larger methods.

---

## 6. Effort estimate (senior engineering)

| Phase | Days |
|---|---|
| FSM audit + missing transitions + tests | 1 |
| V7 service methods 1–6 (find/create/proof) | 2 |
| V7 service methods 7–11 (transition/batch/attempts/history) | 2 |
| V7 service methods 12–13 (beef merge + collectReqsAndBeef) | 2 |
| V7 service methods 14–15 (listActionsForUser, listOutputsForUser) | 2 |
| Wire `listOutputsKnex.ts` + tests | 1 |
| Wire `listActionsKnex.ts` + tests (incl. version/lockTime decision) | 1.5 |
| Wire `createAction.ts` + reference/txid resolution + tests | 2 |
| Wire `processAction.ts` + FSM-rich path + tests | 3 |
| Wire `attemptToPostReqsToNetwork.ts` + EntityProvenTxReq decomposition + tests | 3 |
| Wire `internalizeAction.ts` (merge/new, proven/unproven) + tests | 2.5 |
| Integration & end-to-end test pass post-cutover, fix fall-out | 2 |
| Buffer for FSM edge cases / unforeseen schema gaps | 2 |
| **Total** | **~26 engineering-days (≈5–6 weeks calendar, single senior)** |

Parallelizable: V7 service additions + per-method wiring fan out to 2 engineers → ~3–4 weeks calendar.
