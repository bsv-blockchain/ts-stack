# Wallet-Toolbox — Clean Schema (v3 Greenfield Redesign)

> Status: design document. Target schema for the next major rewrite. The current v3 still carries the v2→v3 bridge tables (`transactions_legacy`, `proven_txs`, `proven_tx_reqs`). This document captures the destination after that bridge is stripped.

## Motivation

The v3 cutover work introduced a `transactions_new` table with an integer `transactionId` PK alongside a `txid` UNIQUE column. The split meant three different keyspaces shared the column name `transactionId`:

| Table | `transactionId` meant |
|---|---|
| `transactions_legacy` | per-user legacy row PK |
| `transactions` (new) | per-txid canonical row PK |
| `outputs` / `commissions` / `tx_audit` | FK to canonical, sometimes carrying a bridge-period legacy value |

This ambiguity caused a string of preventable bugs:

1. Sync writing to `transactions_legacy` but reads JOINing canonical `transactions` → balance reads as 0.
2. MySQL/Postgres FK following the cutover RENAME so `outputs.transactionId` pointed at `transactions_legacy`, breaking every canonical-id write.
3. `tx_labels_map` FK had to be rebuilt mid-cutover and re-validated against a different keyspace.
4. createAction inserted unsigned drafts into `transactions_legacy`, processAction had to remap to canonical, with FK bypasses needed on every engine because the bridge values were FK-impossible.

Every one of those bugs collapses if we never split. Use `txid` as the canonical PK from the start; let `actions` carry an integer `actionId` PK and a NULLABLE `txid` for unsigned drafts.

## Target Schema

### `transactions` — canonical, per-txid
- **PK**: `txid VARCHAR(64)`
- broadcast / proof state: `processing`, `processing_changed_at`, `next_action_at`, `attempts`, `rebroadcast_cycles`, `was_broadcast`, `idempotency_key`, `batch`, `last_provider`, `last_provider_status`, `frozen_reason`, `row_version`
- payload: `raw_tx LONGBLOB`, `input_beef LONGBLOB`
- proof: `height`, `merkle_index`, `merkle_path`, `merkle_root`, `block_hash`, `is_coinbase`
- indexes: `processing`, `batch`, `(processing, next_action_at)`

### `actions` — per-user wallet view
- **PK**: `actionId BIGINT AUTO_INCREMENT`
- `userId` FK→`users(userId)`
- `txid VARCHAR(64) NULL` FK→`transactions(txid)` (NULL while unsigned)
- `reference VARCHAR(64) NOT NULL`
- `description`, `isOutgoing`, `satoshis_delta`, `version`, `lockTime`, `user_nosend`, `hidden`, `user_aborted`
- `raw_tx_draft LONGBLOB NULL`, `input_beef_draft LONGBLOB NULL` — carry pre-signing payload until processAction transfers it into canonical `transactions.raw_tx`
- `notify_json LONGTEXT`, `row_version`
- unique: `(userId, reference)`, `(userId, txid)` — multiple NULL drafts permitted per user, one signed action per `(user, txid)`
- indexes: `(userId, hidden)`, `txid`

### `outputs` — per-action UTXO records
- **PK**: `outputId BIGINT AUTO_INCREMENT`
- `actionId` FK→`actions(actionId)` — owning action
- `userId` denormalised (= `actions.userId`) for hot-path index
- `basketId` FK→`output_baskets(basketId)`, nullable
- `vout`, `satoshis`, `spendable`, `change`, `is_coinbase`, `matures_at_height`
- `outputDescription`, `spendingDescription`, `providedBy`, `purpose`, `type`
- **`txid VARCHAR(64) NULL`** — denormalised mirror of `actions.txid` for direct txid lookups
- **`spentByActionId BIGINT NULL`** FK→`actions(actionId)` — clear "this output was spent by which action"
- scripts: `lockingScript`, `scriptLength`, `scriptOffset`, `senderIdentityKey`, `derivationPrefix`, `derivationSuffix`, `customInstructions`, `sequenceNumber`
- unique: `(actionId, vout)`
- indexes: `(userId, basketId, spendable, satoshis)`, `(userId, spendable, outputId)`, `(userId, txid)`, `spentByActionId`, `matures_at_height`

### `commissions` — per-action wallet fees
- `actionId` FK→`actions(actionId)` (UNIQUE — one commission per action max)
- `userId` denorm, `satoshis`, `keyOffset`, `isRedeemed`, `lockingScript`

### `tx_audit` — FSM transition log
- `auditId` PK
- `txid` FK→`transactions(txid)`, nullable
- `actionId` FK→`actions(actionId)`, nullable
- `event`, `from_state`, `to_state`, `details_json`
- indexes: `event`, `txid`, `actionId`

### `tx_labels_map` — per-action label mapping
- `txLabelId` FK→`tx_labels(txLabelId)`
- `actionId` FK→`actions(actionId)`
- unique: `(txLabelId, actionId)`

### `output_tags_map` — per-output tag mapping (unchanged shape)
- `outputTagId` FK→`output_tags(outputTagId)`
- `outputId` FK→`outputs(outputId)`

### Other tables (unchanged from current v3)
- `users`, `output_baskets`, `output_tags`, `tx_labels`, `chain_tip`, `monitor_lease`, `monitor_events`, `certificates`, `certificate_fields`, `settings`, `sync_states`.

### Tables that DISAPPEAR
- `transactions_legacy` — gone. There is no legacy schema.
- `proven_txs` / `proven_txs_legacy` — merged into `transactions` (the proof columns live on the canonical row).
- `proven_tx_reqs` / `proven_tx_reqs_legacy` — merged into `transactions` (broadcast/processing state lives on the canonical row).
- `transactions_new` — renamed to `transactions`; the suffix is no longer needed.

## Lifecycle Walkthrough

### createAction (unsigned draft)
1. Insert `actions(userId, txid=NULL, reference, raw_tx_draft=NULL, …)`.
2. Insert `outputs(actionId, vout, satoshis, spendable=true, txid=NULL, …)` for every output the wallet creates.
3. For each input being spent, set `outputs.spendable=false` and `outputs.spentByActionId = new actionId` on the row representing the UTXO being consumed. No bridge tables; no FK bypass.
4. If the action has labels, insert `tx_labels_map(txLabelId, actionId)` — `actionId` already exists, FK is satisfied.

### processAction (signing)
1. Caller hands the signed `rawTx` (and therefore the `txid`) back to the toolbox.
2. INSERT into `transactions(txid, raw_tx, processing='unprocessed', …)` (or UPSERT if another wallet already created the canonical row).
3. UPDATE `actions` SET `txid=:txid`, clear `raw_tx_draft` / `input_beef_draft`.
4. UPDATE `outputs` SET `txid=:txid` WHERE `actionId=:thisAction`.
5. Append `tx_audit(txid, actionId, event='processing.changed', …)`.

### sync from another wallet
1. Receive `SyncChunk { transactions: [...], actions: [...], outputs: [...], …}`.
2. For each transaction row, UPSERT by `txid`. Identifier collisions across wallets are no longer possible — `txid` is the universal natural key.
3. For each action row, INSERT (or UPDATE-on-conflict) keyed on `(userId, txid)`.
4. For each output row, INSERT keyed on `(actionId, vout)` after remapping `actionId` to the local wallet's row via `syncMap.action.idMap`.
5. Remap `spentByActionId` and `basketId` through the syncMap; no `transactionId` keyspace problem because that column does not exist anymore.

### listOutputs hot path
```sql
SELECT o.* FROM outputs o
WHERE o.userId = :user
  AND o.basketId = :basket
  AND o.spendable = TRUE
ORDER BY o.satoshis DESC
LIMIT 100
```
No JOIN required — `outputs.spendable` is maintained by the FSM transition layer when the owning action's `processing` state changes (same pattern as today's `spendabilityRefresh`).

When the caller wants the canonical chain state alongside the output:
```sql
SELECT o.*, t.processing, t.height
FROM outputs o
LEFT JOIN transactions t ON t.txid = o.txid
WHERE o.userId = :user AND o.spendable = TRUE
```
JOIN is on `txid` (string) — cleaner semantics, no integer-id ambiguity.

## Migration Stance

**v2 deployments**: not the toolbox's job. v3 ships as a fresh schema; operators carrying real v2 data run their own one-shot ETL outside the toolbox (target: a freshly-migrated v3 database). Documented separately in a runbook.

**Fresh installs**: a single `migrate()` call creates the entire schema at once. No cutover, no `runSchemaCutover`, no `backfillLegacyOnlySync`, no `LEGACY_UPGRADE` env, no `transactions_legacy` marker check in wallet-infra boot.

## Rewrite Scope

The 258 source references to the legacy tables/methods touch ~30 files. Phasing:

1. **Schema migration** — replace `KnexMigrations.ts` with the single greenfield migration in this document.
2. **TableXxx interfaces** — drop `TableTransactionNew` / `TableTransaction` duplication. One `TableTransaction` shape: `{ txid, processing, … }`. `TableAction` keyed by `actionId`, FK `txid`. `TableOutput` adds `actionId` + `spentByActionId`, drops the int `transactionId` / `spentBy` columns.
3. **Strip legacy code paths** — delete `schemaCutover.ts`, `schemaCutoverIdb.ts`, `backfillLegacyOnlySync.ts`, `backfill.ts`, `backfill.knex.ts`, `backfill.idb.ts`, `backfill.runner.ts`. Strip `_postCutoverCache`, `isPostCutover`, `getTransactionService` cutover guard, `insertLegacyTransaction`, `insertLegacyTxLabelMap`, `findLegacyTransactions`, `updateLegacyTransaction`, all FK bypass plumbing (`dbBypassFks`, `transaction()` SET LOCAL emission, `disableForeignKeys`/`enableForeignKeys`).
4. **createAction.ts (999 lines)** — rewrite the new-tx path. `insertLegacyTransaction` → `insertAction`. Outputs FK directly to the action. Inputs marked via `spentByActionId`.
5. **processAction.ts (503 lines)** — rewrite the signing path. UPSERT `transactions(txid, raw_tx, …)`. UPDATE `actions.txid`. UPDATE `outputs.txid` for all outputs of this action. Audit row.
6. **generateChange.ts (656 lines)** — coin selection JOINs to `actions` (per-user filter) + `transactions` (processing filter). The new `allocateChangeInput` query stays the single-pass ORDER BY CASE structure.
7. **listActionsKnex / listOutputsKnex** — the JOIN now goes `actions JOIN transactions ON transactions.txid = actions.txid`. `bulkEnrich` keys on `actionId` for labels/outputs/inputs (already does for outputs).
8. **EntityTransaction / EntityOutput / EntityProvenTx / EntityProvenTxReq** — sync entities collapse. `EntityProvenTx` and `EntityProvenTxReq` become subviews of the canonical `transactions` row; sync chunk emits a single `transactions[]` array.
9. **getSyncChunk** — single transaction chunker. No canonical→legacy remap. Output chunker keyed on `actionId`.
10. **wallet-infra/src/index.ts** — drop the `LEGACY_UPGRADE` branch, drop `runSchemaCutover` + `backfillLegacyOnlySync` invocations. Boot is just `migrate()` + serve.
11. **Monitor tasks** — `TaskCheckForProofs`, `TaskReorg`, `TaskReviewProvenTxs`, `TaskNewHeader`, `TaskPurge` all swap their `proven_tx_reqs` reads for `transactions` reads keyed on `processing`.

Phased delivery — each phase ships a working build:

- **Phase A**: schema + interfaces + storage CRUD methods + minimal lifecycle (createAction → processAction roundtrip works on a fresh DB). Sync left untouched (will read empty chunks against new schema during Phase A).
- **Phase B**: sync rewrite. EntityTransaction / EntityOutput / getSyncChunk on the new shape.
- **Phase C**: monitor tasks + admin server on the new shape.
- **Phase D**: idb client + mobile client mirror.

## Open questions (decide before phase A starts)

1. **`outputs.userId` denorm vs JOIN** — keep denormalised? Saves a JOIN on the hot path but introduces a coherence invariant. Current v3 keeps it denormalised; the redesign keeps that choice.
2. **`outputs.txid` denorm** — same call. Keep it for fast txid lookups; trigger / write-path responsibility to keep it in sync with `actions.txid` once the action is signed.
3. **`commissions.actionId` vs `commissions.txid`** — pick one. `actionId` is per-user (matches the action that owns the fee). Going with `actionId`.
4. **`tx_audit` events** — keep the FSM transition rows. Drop the legacy `history JSON` blob — already gone in current v3.
5. **`actions.raw_tx_draft` size** — sized as LONGBLOB on MySQL. Same TX size budget as `transactions.raw_tx`.

## Why ship this

Eliminates the single biggest source of bugs in the current v3 codebase: the bridge between two parallel transactionId keyspaces. Every FK bypass, every cutover routine, every legacy-table sentinel disappears. The schema reads like the design doc: actions own outputs, transactions own their txid, period.
