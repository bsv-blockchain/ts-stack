# Schema Cutover Runbook

Operator guide for running `runSchemaCutover` (Knex) and `runIdbSchemaCutover` (IndexedDB) against a **populated** production database that's being upgraded from v2. Read top to bottom before starting.

> **Fresh installs do not need this runbook.** Consumer apps (e.g. wallet-infra) auto-detect an empty `transactions` table at boot and silently initialize the v3 layout via the same `runSchemaCutover` call — no operator intervention required. This runbook is for the upgrade path: existing v2 data that must be migrated forward.

---

## 0. Scope

The schema cutover is a one-way destructive migration that:

- Renames legacy `transactions`, `proven_tx_reqs`, `proven_txs` → `*_legacy`.
- Swaps the `transactions_new` table in as the new canonical `transactions`.
- Remaps every FK value in `outputs`, `commissions`, and `tx_labels_map` so that downstream rows continue to reference consistent records.
- Rebuilds `tx_labels_map.transactionId` so its FK points at `actions(actionId)` instead of the renamed legacy table.
- Drops orphan FK rows that reference legacy `transactions` entries lacking a canonical mapping (typically `txid IS NULL` in-flight / aborted rows that have no `transactions_new` counterpart). Outputs pointing at orphan ids are deleted; `outputs.spentBy` pointing at orphans is nulled; `commissions` + `tx_labels_map` orphans are deleted. The legacy `transactions` rows themselves survive (renamed into `transactions_legacy`) for audit. Count is logged: `[schemaCutover] dropping FK rows for N unmapped legacy transactions (no txid)`.

Application code is expected to be running the new-schema storage path (TransactionService + post-cutover table names) BEFORE the cutover starts. Code that still queries `proven_txs` or `proven_tx_reqs` will break the moment the rename completes.

### Cache invalidation: restart the server after a standalone cutover

`StorageKnex` reads `hasTable('transactions_legacy')` once during `makeAvailable()` and caches the result on `_postCutoverCache`. All routing (`findTransactions`, `insertTransaction`, `updateTransaction`, `insertTxLabelMap`, etc.) keys off this cache. **The cache is never refreshed.** A running server that booted pre-cutover will keep routing reads/writes at the new-schema `transactions` table (no `userId`/`description` columns) and fail every legacy-shape query. If you run the cutover via a standalone script (not at boot), **restart the server process afterwards** so `makeAvailable()` re-evaluates the cache.

---

## 1. Pre-flight

| Step | Action |
|------|--------|
| 1.1 | Take a full backup of the database file (SQLite) or `mysqldump` (MySQL). Store off-host. |
| 1.2 | Verify the new-schema additive migration is already applied: `SELECT name FROM sqlite_master WHERE type='table' AND name='transactions_new'` returns one row. |
| 1.3 | Verify deployed code uses the new-schema storage path. If unsure, do not proceed — roll application forward first. |
| 1.4 | Run smoke queries against `transactions_new` and `actions` to confirm shape and indexes match expectations. |
| 1.5 | Estimate the size of legacy data. Cutover scales linearly with row count: each row in `outputs`, `commissions`, and `tx_labels_map` is touched twice (write with offset, write to collapse). Budget roughly 2 minutes per 100k rows on commodity hardware. |
| 1.6 | Confirm no live writer is mid-flight. Either drain the writer pool or place the application in maintenance mode. |

---

## 2. Maintenance window

Cutover is not online-safe. Concurrent writers can see torn reads while the FK value remap is mid-flight. Plan for downtime equal to the cutover duration plus a smoke-test buffer.

| Step | Action |
|------|--------|
| 2.1 | Drain writers; confirm no in-flight Wallet transactions. |
| 2.2 | Stop the Monitor daemon (so it does not race the rename). |
| 2.3 | Run `runSchemaCutover(knex)`. The function logs progress to the standard logger; capture stdout. |
| 2.4 | Run `runIdbSchemaCutover(dbName)` for each IDB-backed client database (if applicable). |
| 2.5 | Verify the renames landed: `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_legacy'` should list three tables. `transactions` must exist and `transactions_new` must not. |

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
| 3.6 | Run `TransactionService.create + transition + recordProof` against a throwaway txid; assert `tx_audit` recorded each event. |
| 3.7 | Run `refreshOutputsSpendable(knex)` and verify the cached `outputs.spendable` matches the §4 rule on a sample of outputs. |
| 3.8 | Bring up one Monitor instance, confirm it claims `monitor_lease`, runs one tick, and releases. |

---

## 4. Rollback

Rollback is best-effort. Once writes have occurred on the post-cutover `transactions` table, those writes have no representation in the renamed legacy tables and rolling back will lose them.

If rollback is necessary AND no post-cutover writes have occurred:

| Step | Action |
|------|--------|
| 4.1 | Stop writers and the Monitor. |
| 4.2 | Run `rollbackSchemaCutover(knex)`. This reverses the table renames but does not undo the FK value remap. |
| 4.3 | If FK values need to be restored to legacy IDs, restore from the pre-flight backup (step 1.1). Do not attempt to invert the offset arithmetic manually — the legacy keyspace may have already been recycled. |

Otherwise: restore from backup, then redeploy the pre-cutover application code.

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

- `runSchemaCutover` is not wrapped in a single SQL transaction: SQLite requires toggling the `legacy_alter_table` pragma between RENAME statements, which is incompatible with a deferred-commit transaction. The function relies on idempotency + the `transactions_legacy` presence guard to recover from partial failure. **Caveat**: if the function throws mid-remap, the idempotency guard will short-circuit subsequent invocations because `transactions_legacy` may already exist from the partial run. Recovery requires manually inspecting state (or restoring from backup at step 1.1).
- `outputs.maturesAtHeight` is populated only for newly inserted coinbase outputs. Legacy coinbase outputs need a one-off backfill before the §4 rule will allow them to be spendable.
- MySQL is supported but not yet covered by automated integration tests in this repository. Run a staging dry-run before production. MySQL-specific behaviour to keep in mind: (1) `RENAME TABLE` rewrites FK metadata on referencing tables, so `outputs`/`commissions` FKs to `transactions` follow the rename to `transactions_legacy` and stay there — bridge-period inserts using legacy `transactionId` values still satisfy those FKs without needing `SET FOREIGN_KEY_CHECKS=0`. (2) `tx_labels_map.transactionId` FK is explicitly dropped + re-added to reference `actions.actionId` during cutover, so bridge-period sync inserts DO need `SET FOREIGN_KEY_CHECKS=0` (handled inside `insertTxLabelMap`).
