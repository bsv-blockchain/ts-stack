# PROD_REQ_V7_TS.md — BSV Wallet UTXO & Transaction Lifecycle Specification (TypeScript Implementation)

**Version:** 7.0  
**Date:** 2026-05-11  
**Target Implementation:** Current `@bsv/wallet-toolbox` (TypeScript)  
**Status:** Draft — Self-contained migration target from the **current TypeScript schema only**. No reference to any prior V2–V6 drafts.

---

## 0. Purpose (for the current TypeScript implementation)

This document defines the **next evolution** of the TypeScript wallet toolbox specifically for the software that manages UTXOs and broadcast status for a set of transactions on behalf of its users.

It starts from the **exact current TS schema** you have today:
- `transactions` table (per-user status, description, labels, etc.)
- `proven_tx_reqs` table (per-txid broadcast queue + processing state)
- `proven_txs` table (final Merkle proofs)
- `outputs` table + `user_utxos` (in some deployments)
- `output_tags` / `output_tags_map`

**V7 goal:** Clean separation while preserving (and slightly improving) the single-table query speed you already enjoy for the common “find spendable outputs in default basket” query.

---

## 1. Current TypeScript Schema (starting point — do not change yet)

### 1.1 `transactions` (current)
Per-user view. Contains `status`, description, labels, satoshis, etc.

### 1.2 `proven_tx_reqs` (current)
Per-txid processing queue. Contains status (sending, unmined, callback, unconfirmed, completed, invalid, doubleSpend, etc.), attempts, wasBroadcast, rebroadcastAttempts, inputBEEF, rawTx, history JSON, etc.

### 1.3 `proven_txs` (current)
Final proof storage. Contains height, index, merklePath, blockHash, merkleRoot, rawTx.

### 1.4 `outputs`
Stores output data. In many TS deployments there is also a `user_utxos` side table for fast per-user queries.

### 1.5 Other tables
`output_baskets`, `output_tags`, `output_tags_map`, `tx_labels`, `tx_labels_map`, etc. remain unchanged in V7.

---

## 2. V7 Target Schema (TS-specific)

### 2.1 `transactions` (new canonical per-txid table)
This becomes the single source of truth for everything about a transaction on the network.

Columns (merged from current `proven_tx_reqs` + `proven_txs` + necessary fields):
- `transactionId` (PK)
- `txid` (UNIQUE)
- `processing` (granular FSM: queued, sending, sent, seen, seen_multi, unconfirmed, proven, reorging, invalid, doubleSpend, unfail, frozen, nosend, nonfinal)
- `processing_changed_at`
- `next_action_at`
- `attempts`
- `rebroadcast_cycles`
- `was_broadcast`
- `idempotency_key`
- `batch`
- `raw_tx`
- `input_beef`
- `height`, `merkle_index`, `merkle_path`, `merkle_root`, `block_hash`
- `is_coinbase`
- `last_provider`, `last_provider_status`
- `frozen_reason`
- `row_version`
- `created_at`, `updated_at`

**All broadcast, proof, and blockchain status live here — exactly once per txid.**

### 2.2 `actions` (new per-user view table)
Migrated from your current `transactions` table.

Columns:
- `actionId` (PK)
- `userId`
- `transactionId` (FK → transactions)
- `reference`
- `description`
- `is_outgoing`
- `satoshis_delta`
- `user_nosend`
- `hidden`
- `user_aborted`
- `notify_json`
- `row_version`
- `created_at`, `updated_at`

UNIQUE `(userId, transactionId)`

This table holds everything that is truly per-user: description, labels (via tx_labels_map pointing to actionId), notification subscribers, soft-delete/hidden flags, etc.

### 2.3 `outputs` (single optimized table — the key performance win)
**This is the pragmatic optimization we discussed.**

- One table: `outputs`
- Every column you need lives here: txid, vout, user_id, amount, locking_script, spendable, basketId, label, description, is_coinbase, matures_at_height, spent_by, etc.
- Unique constraint: `(txid, vout, user_id)`
- For the 99%+ case where only one user cares about an output → exactly one row.
- For the rare shared-output case (multi-sig, shared wallets, etc.) → we simply insert a second row with the same txid+vout but different user_id. Data is duplicated, but the duplication is tiny and the query stays a single-table index scan.

**Your hot query stays exactly as fast as today:**
```sql
SELECT * FROM outputs 
WHERE user_id = ? 
  AND spendable = true 
  AND basketId = default_basket
ORDER BY satoshis DESC
LIMIT 100;
```
No joins. Same performance.

### 2.4 Tags & Labels
- `output_tags` + `output_tags_map` stay exactly as they are today.
- `tx_labels` + `tx_labels_map` now point to `actionId` instead of the old transactionId (per-user labels).

### 2.5 New supporting tables (same as V5)
- `chain_tip` (singleton)
- `tx_audit` (per-event log with transactionId + actionId scope)
- `monitor_lease`

---

## 3. Migration Guide — From Current TypeScript Implementation to V7

This migration is designed to be run **once**, safely, with zero downtime for reads.

### Step 1: Create new tables (non-destructive)
```sql
CREATE TABLE actions ( ... full definition as in §2.2 ... );
CREATE TABLE transactions_new ( ... full definition as in §2.1 ... );
CREATE TABLE outputs_new ( ... full definition as in §2.3 ... );
```

### Step 2: Backfill `actions` from current `transactions`
```sql
INSERT INTO actions (userId, transactionId, reference, description, is_outgoing, satoshis_delta, 
                     user_nosend, hidden, user_aborted, notify_json, created_at, updated_at)
SELECT userId, transactionId, reference, description, isOutgoing, satoshis,
       CASE WHEN status = 'nosend' THEN TRUE ELSE FALSE END,
       FALSE, FALSE, notify_json, created_at, updated_at
FROM transactions;
```

### Step 3: Migrate `proven_tx_reqs` + `proven_txs` → new `transactions`
For every txid that exists in either table, create a row in `transactions_new`:
- Merge processing state from `proven_tx_reqs.status`
- Merge proof fields from `proven_txs`
- Map old status values to the new granular `processing` enum (e.g. `completed` → `proven`, `unmined` → `sent`, `invalid` stays `invalid`)

### Step 4: Migrate outputs (the important performance-preserving step)
```sql
INSERT INTO outputs_new (txid, vout, user_id, amount, locking_script, spendable, 
                         basketId, label, description, is_coinbase, matures_at_height, 
                         spent_by, created_at, updated_at)
SELECT o.txid, o.vout, t.userId, o.satoshis, o.lockingScript, o.spendable,
       o.basketId, o.label, o.description, o.is_coinbase, o.matures_at_height,
       o.spentBy, o.created_at, o.updated_at
FROM outputs o
JOIN transactions t ON t.transactionId = o.transactionId;
```

For any output that already appears for multiple users (rare in current TS), this naturally creates multiple rows — exactly the duplication we want.

### Step 5: Re-point foreign keys
- Update `tx_labels_map` to point to new `actionId` instead of old `transactionId`.
- Update any other references from `proven_tx_reqs` / `proven_txs` to the new `transactions` table.

### Step 6: Atomic cutover (single transaction or brief maintenance window)
```sql
BEGIN;
  RENAME TABLE transactions TO transactions_old;
  RENAME TABLE transactions_new TO transactions;
  RENAME TABLE outputs TO outputs_old;
  RENAME TABLE outputs_new TO outputs;
  RENAME TABLE proven_tx_reqs TO proven_tx_reqs_old;
  RENAME TABLE proven_txs TO proven_txs_old;
  -- Drop old tables after verification
COMMIT;
```

### Step 7: Post-migration cleanup
- Drop `proven_tx_reqs_old`, `proven_txs_old`, `transactions_old`, `outputs_old`.
- Rebuild any indexes that were on the old tables.
- Run the full conformance test suite (see §5).

---

## 4. Spendability Derivation (V7 — unchanged from current TS logic, just cleaner)

```sql
spendable = (transactions.processing IN ('sent', 'seen', 'seen_multi', 'unconfirmed', 'proven'))
            AND outputs.spent_by IS NULL
            AND outputs.locking_script IS NOT NULL
            AND (NOT outputs.is_coinbase OR outputs.matures_at_height <= chain_tip.height)
```

The `outputs.spendable` column remains a cached boolean, refreshed atomically on every relevant state change.

---

## 5. Conformance Tests (must pass after migration)

- All existing TS tests continue to pass.
- New tests for:
  - Single-table spendable query performance (no regression).
  - Multi-user deduplication (one `transactions` row, multiple `actions` rows).
  - Shared output duplication (two rows with same txid+vout, different user_id).
  - Reorg handling on the new `transactions` table.
  - Granular processing FSM transitions.

---

## 6. Rollout Recommendation

1. Run the migration on a staging copy of production data.
2. Verify query performance on the hot “spendable outputs” path.
3. Deploy V7 code that writes to the new schema.
4. Keep the old tables for one release as a rollback safety net.
5. Drop legacy tables after 30 days of stable operation.

---

**This document is the complete, self-contained target for the current TypeScript implementation.**

End of PROD_REQ_V7_TS.md
