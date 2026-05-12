# V7 createAction.ts Wiring — Blockers Analysis

## Decision: Analysis doc over immediate implementation

Attempting minimal wiring of `createAction.ts` in isolation would immediately break **all**
existing `createAction` tests. Those tests use `createLegacyWalletSQLiteCopy()` which calls
`activeStorage.migrate()` but NOT `runV7Cutover()`. The `transactions_v7` and `actions` tables
do not exist in those test databases. Any `V7TransactionService` call inside `createAction.ts`
would throw `no such table: transactions_v7` at runtime, causing all 50+ createAction tests to fail.

Additionally, `createAction.ts` cannot safely create V7 rows in isolation because the real `txid`
is unknown at `createAction` time. An abandoned sentinel in `transactions_v7` with no corresponding
sentinel-rewrite in `processAction.ts` would leave every new transaction in a permanently broken
V7 state. The two methods must be wired together.

This document enumerates three concrete options with exact line-level change maps and effort
estimates so the next engineer can make an informed implementation choice.

---

## 1. API contract `createAction` must preserve

`createAction(storage: StorageProvider, auth: AuthId, vargs: ValidCreateActionArgs)`
returns `StorageCreateActionResult` with these fields:

```
reference     string   (randomBytesBase64(12) — set in createNewTxRecord, line 482)
version       number   (from vargs)
lockTime      number   (from vargs)
inputs        StorageCreateTransactionSdkInput[]
outputs       StorageCreateTransactionSdkOutput[]
derivationPrefix  string
inputBeef     number[] | undefined
noSendChangeOutputVouts  number[] | undefined
```

The `reference` value is the **only cross-method linkage** between `createAction` and
`processAction`. When `processAction` is later called, it locates the pending transaction via:

```typescript
// processAction.ts line 307-311
const transaction = verifyOne(
  await storage.findTransactions({ partial: { userId, reference: params.reference } })
)
```

This means `reference` is available in `processAction`, which is critical for all three options below.

---

## 2. The reference/txid timing problem

### Timeline

```
createAction called
  ↓  storage.insertTransaction({ txid: undefined, status: 'unsigned', reference: R })
  ↓  legacy transactionId T allocated
  ↓  outputs/labels created, satoshis computed
  ↓  returns reference R to caller
          (wallet signs the transaction outside storage layer)
processAction called with { reference: R, txid: REAL_TXID, rawTx: [...] }
  ↓  storage.findTransactions({ userId, reference: R }) → retrieves T
  ↓  storage.insertTransaction + updateTransaction with real txid
```

### V7 constraint

`transactions_v7.txid VARCHAR(64) NOT NULL UNIQUE` (migration line 101). Every row must have
a non-null, unique, 64-char-max txid **at insert time**. The real txid is not known until
signing completes outside the storage layer.

### The keyspace difference for labels

Post-cutover `tx_labels_map.transactionId` is an FK to `actions.actionId` (not
`transactions_v7.transactionId`). The current `createNewTxRecord` (lines 493-496) writes:

```typescript
for (const label of vargs.labels) {
  const txLabel = await storage.findOrInsertTxLabel(userId, label)
  await storage.findOrInsertTxLabelMap(
    verifyId(newTx.transactionId),   // ← legacy transactionId
    verifyId(txLabel.txLabelId)
  )
}
```

Post-cutover this must pass `actionId` instead. This cannot be fixed until an `actions` row
exists, which requires `transactionId` from a `transactions_v7` row, which requires `txid`.

---

## 3. Three concrete solution sketches

### Option A — Sentinel txid (recommended)

**Concept:** Insert a `transactions_v7` row immediately with a unique placeholder txid
`'pending:' + legacyTransactionId` (e.g. `'pending:42'`). The sentinel is at most 18 chars,
well under the VARCHAR(64) limit. It is guaranteed unique because `legacyTransactionId` is
auto-increment unique. `processAction` rewrites it to the real txid when it commits.

#### Changes in `createAction.ts`

**Prerequisite (one-time):** Add a `getV7Service(): V7TransactionService | undefined` method
to `StorageProvider` (returns `undefined` by default). Override it in `StorageKnex` to return
`new V7TransactionService(this.knex)`. This avoids a type-unsafe cast while keeping the
`StorageProvider` interface stable.

```
StorageProvider.ts  +6 lines   abstract/default getV7Service()
StorageKnex.ts      +7 lines   override getV7Service()
```

**In `createNewTxRecord`** (lines 468-499):

After line 491 (`newTx.transactionId = await storage.insertTransaction(newTx)`), add:

```typescript
// V7 additive wiring — create a V7 transaction row with a pending sentinel txid.
// processAction MUST rewrite this sentinel to the real txid after signing.
// See V7_CREATEACTION_BLOCKERS.md §3 Option A.
const v7svc = storage.getV7Service()
if (v7svc != null) {
  const sentinelTxid = `pending:${newTx.transactionId}` as string
  const v7Tx = await v7svc.create({
    txid: sentinelTxid,
    processing: 'queued',
    inputBeef: storageBeef.toBinary()
  })
  // Create the per-user actions row (satoshisDelta=0, updated after fund)
  const actionId = await v7svc.createAction({
    userId,
    transactionId: v7Tx.transactionId,
    reference: newTx.reference,
    description: vargs.description,
    isOutgoing: true,
    satoshisDelta: 0
  })
  newTx._v7ActionId = actionId        // stash on in-memory object only (no DB column)
  newTx._v7TransactionId = v7Tx.transactionId
}
```

After line 142 (`await storage.updateTransaction(newTx.transactionId, { satoshis })`), add:

```typescript
// V7 additive wiring — update satoshisDelta now that funding is known.
// TODO(processAction-wiring): migrate tx_labels_map writes to pass actionId here
//   once sentinel is replaced with real txid in processAction.
if (v7svc != null && newTx._v7ActionId != null) {
  await v7svc.updateActionSatoshisDelta(newTx._v7ActionId, satoshis)
}
```

The `tx_labels_map` writes (line 495: `findOrInsertTxLabelMap(legacyTransactionId, ...)`) remain
using the legacy `transactionId` for now. Mark with comment:
```typescript
// TODO(v7-label-wiring): post-cutover this must pass actionId; deferred until
// processAction-wiring resolves the sentinel-to-txid rewrite.
```

#### Changes in `processAction.ts`

In `validateCommitNewTxToStorageArgs`, after line 318 (`const transactionId = verifyId(...)`),
the legacy `transactionId` is known. Add sentinel-rewrite:

```typescript
// V7 additive wiring — rewrite sentinel txid to real txid now that it is known.
const v7svc = storage.getV7Service()
if (v7svc != null) {
  const sentinel = `pending:${transactionId}` as string
  // Update transactions_v7 row: sentinel → real txid, attach rawTx
  await v7svc.knex('transactions').where({ txid: sentinel }).update({
    txid: params.txid,
    raw_tx: Buffer.from(params.rawTx),
    input_beef: null,   // now stored in proven_tx_reqs / rawTx
    updated_at: new Date()
  })
  // Resolve actionId for subsequent V7 FSM transition
  const found = await v7svc.findActionByUserTxid(userId, params.txid)
  // found.transaction.transactionId is the V7 transactionId for transitionMany
}
```

**Labels must also be rewritten here** (post-cutover): find the action and update
`tx_labels_map.transactionId` from `legacyTransactionId` to `actionId`. This is the
"TODO(v7-label-wiring)" left in createAction and completed in processAction wiring.

#### Effort

| Sub-task | Hours |
|---|---|
| Add `getV7Service()` to StorageProvider + override in StorageKnex | 0.5 |
| Add sentinel create/satoshis update in `createNewTxRecord` | 1.5 |
| Write 3 integration tests (pre-cutover skips; post-cutover sentinel created + satoshis) | 2 |
| Add sentinel-rewrite to `processAction.validateCommitNewTxToStorageArgs` | 1.5 |
| Migrate `tx_labels_map` writes to use `actionId` post-cutover | 1 |
| Write 2 integration tests (sentinel resolved; label keyspace correct post-cutover) | 2 |
| Fix pre-cutover test helpers to skip or guard V7 calls | 0.5 |
| **Total** | **~9 hours** |

---

### Option B — Defer V7 row creation entirely to `processAction`

**Concept:** Do not touch `createAction.ts` at all. In `processAction.ts`, after the legacy
transaction row is updated with the real txid (line 421: `storage.updateTransaction(...)`),
create the V7 `transactions_v7` row and `actions` row in one shot using
`V7TransactionService.findOrCreateActionForTxid`.

```typescript
// After commitNewTxToStorage — V7 additive wiring
const v7svc = (storage as StorageKnex).getV7Service?.()
if (v7svc != null) {
  await v7svc.findOrCreateActionForTxid({
    userId,
    txid: vargs.txid,
    isOutgoing: true,
    description: vargs.transaction.description!,
    satoshisDelta: vargs.transaction.satoshis!,
    reference: vargs.reference,
    rawTx: vargs.rawTx,
    inputBeef: asArray(vargs.transaction.inputBEEF!),
    processing: vargs.isNoSend ? 'nosend' : 'queued'
  })
}
```

#### Advantages
- Zero changes to `createAction.ts`
- No sentinel/rewrite complexity
- Single location for V7 row creation (processAction)
- `tx_labels_map` migration can also happen here

#### Disadvantages
- V7 rows don't exist for the `createAction → processAction` gap. If the wallet crashes between
  `createAction` and `processAction`, the V7 layer has no record of the pending transaction.
  Recovery depends entirely on the legacy table.
- `tx_labels_map.transactionId` must still be migrated to use `actionId`. In `processAction`
  we'd need to UPDATE those rows from `legacyTransactionId` to `actionId`.
- When `processAction` calls `findOrCreateActionForTxid`, the `satoshisDelta` must come from
  `transaction.satoshis` (legacy column). Post-cutover this column is gone. So B only works in
  the legacy-table era, not post-cutover.

**Not recommended** for a definitive V7 migration path, but acceptable as a bridge in a
pre-cutover world since `satoshis` is still readable.

#### Effort

| Sub-task | Hours |
|---|---|
| Add `getV7Service()` to StorageProvider + override in StorageKnex | 0.5 |
| Add `findOrCreateActionForTxid` call in `commitNewTxToStorage` | 1.5 |
| Migrate `tx_labels_map` transactionId→actionId in processAction | 1 |
| Write 3 integration tests | 2 |
| **Total** | **~5 hours** |

---

### Option C — Schema change: make `txid` nullable in `transactions_v7`

**Concept:** Add a migration to ALTER `transactions_v7` to allow `txid` to be NULL (with UNIQUE
nullable — SQL NULL ≠ NULL so multiple NULLs are allowed). Insert `transactions_v7` rows with
`txid = NULL` at `createAction` time. Populate `txid` at `processAction` time.

#### Advantages
- No sentinel hackery
- Semantically clean: `txid = NULL` means "unsigned, not yet broadcast"

#### Disadvantages
- Requires a new migration (migration number management, down path)
- Post-cutover code that does `WHERE txid = ?` must handle the NULL case
- `findOrCreateActionForTxid` signature would need adjustment (txid optional)
- `V7TransactionService.findByTxid` would need a NULL guard
- More blast radius than Option A or B

#### Effort

| Sub-task | Hours |
|---|---|
| New migration + down path | 1 |
| Update `findOrCreateActionForTxid`, `findByTxid`, `create` to accept null txid | 2 |
| Update createAction.ts to insert null-txid V7 row | 1.5 |
| Update processAction.ts to populate txid | 1 |
| Update all queries that join/filter on txid to handle null | 1.5 |
| Integration tests | 2.5 |
| **Total** | **~9.5 hours** |

---

## 4. Specific lines changed per option

### Option A changes

| File | Line(s) | Change |
|---|---|---|
| `StorageProvider.ts` | ~73 (class body) | Add `getV7Service(): V7TransactionService \| undefined { return undefined }` |
| `StorageKnex.ts` | ~77 (after constructor) | Override `getV7Service() { return new V7TransactionService(this.knex) }` |
| `createAction.ts` | 491 (after `insertTransaction`) | Add sentinel create + action create (see §3-A) |
| `createAction.ts` | 142 (after `updateTransaction satoshis`) | Add `updateActionSatoshisDelta` call |
| `createAction.ts` | 495 (`findOrInsertTxLabelMap`) | Add `// TODO(v7-label-wiring)` comment |
| `processAction.ts` | 318 (after `transactionId = verifyId`) | Add sentinel-rewrite UPDATE + label migration |

### Option B changes

| File | Line(s) | Change |
|---|---|---|
| `StorageProvider.ts` | ~73 | Add `getV7Service()` |
| `StorageKnex.ts` | ~77 | Override `getV7Service()` |
| `processAction.ts` | ~421 (after `updateTransaction`) | Add `findOrCreateActionForTxid` call + label migration |

### Option C changes

| File | Line(s) | Change |
|---|---|---|
| `KnexMigrations.ts` | After migration `2026-05-11-001` | New migration altering `txid` to nullable |
| `v7Service.ts` | `create`, `findByTxid`, `findOrCreateActionForTxid` | Accept/handle null txid |
| `createAction.ts` | 491 | Insert null-txid V7 row |
| `processAction.ts` | 318 | Populate txid on V7 row |
| `v7Crud.ts` | `insertTransactionV7` | Allow null txid |

---

## 5. Recommendation

**Use Option B** for the current migration phase (pre-cutover, legacy tables still in-place):

1. It has the lowest risk to existing tests — **zero changes to `createAction.ts`**.
2. The entire V7 row creation happens atomically in `processAction.commitNewTxToStorage`
   where both the real `txid` and the legacy `satoshis` (still readable) are known.
3. `tx_labels_map` migration from `legacyTransactionId` to `actionId` can be done in one
   place in `processAction` rather than split across two methods.
4. A crash in the `createAction`→`processAction` gap leaves an orphan V7 row risk (Option A)
   or a gap with no V7 row (Option B) — both are acceptable since the legacy table is the
   source of truth until full cutover.
5. The `findOrCreateActionForTxid` method is already implemented and covers both the
   "brand new txid" and "txid seen before via internalizeAction" cases.

**Migration label fix in Option B** (needed in `processAction`):
```typescript
// After findOrCreateActionForTxid resolves actionId:
// Update tx_labels_map rows that were written with legacyTransactionId → actionId
await storage.knex('tx_labels_map')
  .where({ transactionId: legacyTransactionId })
  .update({ transactionId: actionId })
```
(Note: this UPDATE is post-cutover only — pre-cutover `tx_labels_map.transactionId` is still
the legacy transactionId. Guard with `if (v7svc != null)` and ensure it runs inside the same
DB transaction as `commitNewTxToStorage`.)

**Switch to Option A** if the `createAction`→`processAction` gap recovery becomes a
production concern (e.g. monitoring needs to see unsigned transactions in the V7 layer).
At that point the sentinel approach provides visibility across the full lifecycle.

---

## 6. Prerequisites for either option

Before coding either Option A or B:

1. **`getV7Service()` on StorageProvider** (0.5h) — needed by both options. Both `createAction.ts`
   and `processAction.ts` take `storage: StorageProvider` (not `StorageKnex`). Without this
   accessor, accessing `storage.knex` requires a type-unsafe cast. One clean interface method
   isolates the coupling.

2. **Test helper: post-cutover setup** — both options add V7 writes that require `transactions_v7`
   to exist. New integration tests must use a test helper that calls `runV7Cutover()`. The
   pattern already established in `test/storage/v7ServiceExpansion.test.ts` (uses
   `createSQLiteTestSetup2Wallet` + `runV7Cutover`) is the model.

3. **Existing createAction tests must continue to pass** — both options guard V7 calls with
   `if (v7svc != null)`. Pre-cutover databases return `undefined` from `getV7Service()` is
   incorrect; `getV7Service()` always returns a service (the Knex tables just won't exist).
   The correct guard is: catch the "no such table" error and log a warning, or check
   `storage.isV7CutoverDone()` (a flag that could be added to StorageKnex). The simplest
   guard for Option B is to wrap the entire V7 block in a try/catch that silently no-ops on
   "no such table" errors during the pre-cutover test era.

---

## 7. Summary table

| Criterion | Option A (sentinel) | Option B (defer to processAction) | Option C (nullable txid) |
|---|---|---|---|
| createAction.ts changes | Yes (additive) | None | Yes (additive) |
| processAction.ts changes | Yes (sentinel rewrite) | Yes (V7 create) | Yes (populate txid) |
| Schema migration needed | No | No | Yes |
| Crash-gap V7 visibility | Yes (sentinel row) | No (V7 row only after sign) | Yes (null-txid row) |
| Existing test breakage risk | Medium (needs guard) | Low (zero createAction changes) | Medium (nullable queries) |
| Effort (hours) | ~9 | ~5 | ~9.5 |
| **Recommendation** | Second choice | **First choice** | Not recommended |
