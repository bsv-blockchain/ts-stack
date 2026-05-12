# V7 Cutover Runbook

Operator guide for running `runV7Cutover` (Knex) and `runV7IdbCutover` (IndexedDB) against a populated production database. Read top to bottom before starting.

---

## 0. Scope

The V7 cutover is a one-way destructive migration that:

- Renames legacy `transactions`, `proven_tx_reqs`, `proven_txs` → `*_legacy`.
- Swaps the V7 `transactions_v7` table in as the new canonical `transactions`.
- Remaps every FK value in `outputs`, `commissions`, and `tx_labels_map` so that downstream rows continue to reference consistent records.
- Rebuilds `tx_labels_map.transactionId` so its FK points at `actions(actionId)` instead of the renamed legacy table.

Application code is expected to be running the V7 storage path (V7TransactionService + post-cutover table names) BEFORE the cutover starts. Code that still queries `proven_txs` or `proven_tx_reqs` will break the moment the rename completes.

---

## 1. Pre-flight

| Step | Action |
|------|--------|
| 1.1 | Take a full backup of the database file (SQLite) or `mysqldump` (MySQL). Store off-host. |
| 1.2 | Verify the V7 additive migration is already applied: `SELECT name FROM sqlite_master WHERE type='table' AND name='transactions_v7'` returns one row. |
| 1.3 | Verify deployed code uses the V7 storage path. If unsure, do not proceed — roll application forward first. |
| 1.4 | Run smoke queries against `transactions_v7` and `actions` to confirm shape and indexes match expectations. |
| 1.5 | Estimate the size of legacy data. Cutover scales linearly with row count: each row in `outputs`, `commissions`, and `tx_labels_map` is touched twice (write with offset, write to collapse). Budget roughly 2 minutes per 100k rows on commodity hardware. |
| 1.6 | Confirm no live writer is mid-flight. Either drain the writer pool or place the application in maintenance mode. |

---

## 2. Maintenance window

Cutover is not online-safe. Concurrent writers can see torn reads while the FK value remap is mid-flight. Plan for downtime equal to the cutover duration plus a smoke-test buffer.

| Step | Action |
|------|--------|
| 2.1 | Drain writers; confirm no in-flight Wallet transactions. |
| 2.2 | Stop the Monitor daemon (so it does not race the rename). |
| 2.3 | Run `runV7Cutover(knex)`. The function logs progress to the standard logger; capture stdout. |
| 2.4 | Run `runV7IdbCutover(dbName)` for each IDB-backed client database (if applicable). |
| 2.5 | Verify the renames landed: `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_legacy'` should list three tables. `transactions` must exist and `transactions_v7` must not. |

---

## 3. Smoke tests

Run these against production immediately after the cutover and before reopening the writer pool.

| Step | Query / assertion |
|------|-------------------|
| 3.1 | `SELECT COUNT(*) FROM transactions` matches the row count of `transactions_legacy.txid DISTINCT` from the pre-cutover state. |
| 3.2 | `SELECT COUNT(*) FROM actions` matches the row count of `transactions_legacy`. |
| 3.3 | Pick five txids at random from `transactions_legacy`; assert each appears in `transactions` with the correct `processing` state derived from the legacy `proven_tx_reqs_legacy.status`. |
| 3.4 | `SELECT COUNT(*) FROM outputs o LEFT JOIN transactions t ON t.transactionId = o.transactionId WHERE t.transactionId IS NULL` returns 0 (no orphans). |
| 3.5 | `SELECT COUNT(*) FROM tx_labels_map lm LEFT JOIN actions a ON a.actionId = lm.transactionId WHERE a.actionId IS NULL` returns 0 (no orphans). |
| 3.6 | Run `V7TransactionService.create + transition + recordProof` against a throwaway txid; assert `tx_audit` recorded each event. |
| 3.7 | Run `refreshOutputsSpendable(knex)` and verify the cached `outputs.spendable` matches the §4 rule on a sample of outputs. |
| 3.8 | Bring up one Monitor instance, confirm it claims `monitor_lease`, runs one tick, and releases. |

---

## 4. Rollback

Rollback is best-effort. Once writes have occurred on the post-cutover `transactions` table, those writes have no representation in the renamed legacy tables and rolling back will lose them.

If rollback is necessary AND no post-cutover writes have occurred:

| Step | Action |
|------|--------|
| 4.1 | Stop writers and the Monitor. |
| 4.2 | Run `rollbackV7Cutover(knex)`. This reverses the table renames but does not undo the FK value remap. |
| 4.3 | If FK values need to be restored to legacy IDs, restore from the pre-flight backup (step 1.1). Do not attempt to invert the offset arithmetic manually — the legacy keyspace may have already been recycled. |

Otherwise: restore from backup, then redeploy the pre-V7 application code.

---

## 5. Post-cutover hygiene

| Step | Action |
|------|--------|
| 5.1 | Leave `*_legacy` tables in place for 30 days as a recovery aid. |
| 5.2 | After the soak period, drop `transactions_legacy`, `proven_tx_reqs_legacy`, `proven_txs_legacy` with the next maintenance window. |
| 5.3 | Re-run `refreshOutputsSpendable(knex)` after each chain tip advance to keep the cached column in sync. |
| 5.4 | Monitor `tx_audit.processing.rejected` rows; sustained growth indicates a caller is attempting impossible FSM transitions. |

---

## 6. Known limitations

- `runV7Cutover` is not wrapped in a single SQL transaction: SQLite requires toggling the `legacy_alter_table` pragma between RENAME statements, which is incompatible with a deferred-commit transaction. The function relies on idempotency + the `transactions_legacy` presence guard to recover from partial failure.
- `outputs.maturesAtHeight` is populated only for newly inserted coinbase outputs. Legacy coinbase outputs need a one-off backfill before the §4 rule will allow them to be spendable.
- MySQL is supported but not yet covered by automated integration tests in this repository. Run a staging dry-run before production.
