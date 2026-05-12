# PROD_REQ_V2.md — BSV Wallet Transaction & UTXO Management Specification

**Version:** 2.0
**Date:** 2026-05-11
**Status:** Draft — for review by `@bsv/wallet-toolbox` (TypeScript, canonical) and `go-wallet-toolbox` (Go, conforming) maintainers.

---

## 0. Purpose & Compatibility Mandate

This document supersedes `bsv_wallet_transaction_requirements.md` (v1.0, May 2026). It is the **single source of truth** for transaction broadcast, proof acquisition, and UTXO spendability across **both** wallet implementations.

### Core mandate

1. **TypeScript implementation (`@bsv/wallet-toolbox`) is canonical** for behavior. Where v1.0 disagreed with TS, v2.0 codifies TS behavior, then layers on improvements both implementations must adopt.
2. **Go implementation (`go-wallet-toolbox`) must reproduce TS behavior bit-for-bit.** Any user-visible divergence is a Go bug.
3. **Schema parity is mandatory.** Both implementations must read and write the same physical schema. A wallet instance backed by a SQLite/MySQL/Postgres DB written by TS must be openable by Go and continue operating without migration, and vice versa.
4. **No silent diffs.** Every behavior with a wire- or DB-observable effect is enumerated here and gated by named tests in §13.

### Versioning rule

A schema or FSM change requires a new spec version with a migration plan covering both implementations. Adding fields without renaming or repurposing existing ones is permitted as a minor revision (2.x); changes to the FSM, output spendability rules, or column semantics require a major revision (3.0).

---

## 1. Canonical Database Schema

The following tables and columns are mandatory. Both implementations MUST create them with identical names, identical column names, identical types (within the SQL dialect's nearest equivalent), and identical constraints. Tables and columns absent from this list MUST NOT be added without a spec revision.

### 1.1 `transactions`

User-facing transaction record. Lifecycle reflects what the user/app sees.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `transactionId` | bigint, auto-increment | PK | |
| `userId` | bigint | FK → `users.userId`, NOT NULL | |
| `provenTxId` | bigint NULL | FK → `proven_txs.provenTxId` | Set when transaction reaches `completed` |
| `status` | varchar(64) | NOT NULL, indexed | See §2.1 |
| `reference` | varchar(64) | NOT NULL, UNIQUE | Random base64 token |
| `isOutgoing` | boolean | NOT NULL | true if wallet-created |
| `satoshis` | bigint | NOT NULL, default 0 | Net wallet delta |
| `version` | int unsigned NULL | | tx.version |
| `lockTime` | int unsigned NULL | | tx.lockTime |
| `description` | varchar(2048) | NOT NULL | User description |
| `txid` | varchar(64) NULL, indexed | | Computed once signed |
| `inputBEEF` | binary NULL | | |
| `rawTx` | binary NULL | | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

### 1.2 `outputs`

UTXO state. **Single source of truth for spendability**: the `spendable` boolean flag.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `outputId` | bigint, auto-increment | PK | |
| `userId` | bigint | FK → `users.userId`, NOT NULL | |
| `transactionId` | bigint | FK → `transactions.transactionId`, NOT NULL | |
| `basketId` | bigint NULL | FK → `output_baskets.basketId` | |
| `spendable` | boolean | NOT NULL, default false | **Single source of truth — see §5** |
| `change` | boolean | NOT NULL, default false | |
| `vout` | int | NOT NULL | |
| `satoshis` | bigint | NOT NULL | |
| `providedBy` | varchar(130) | NOT NULL | enum `you|storage|you-and-storage` |
| `purpose` | varchar(20) | NOT NULL | |
| `type` | varchar(50) | NOT NULL | e.g. `P2PKH` |
| `outputDescription` | varchar(2048) | NOT NULL | |
| `txid` | varchar(64) NULL | | |
| `senderIdentityKey` | varchar(130) NULL | | |
| `derivationPrefix` | varchar(200) NULL | | |
| `derivationSuffix` | varchar(200) NULL | | |
| `customInstructions` | varchar(2500) NULL | | |
| `spentBy` | bigint NULL | FK → `transactions.transactionId`, indexed | Set when output is consumed |
| `sequenceNumber` | int unsigned NULL | | |
| `spendingDescription` | varchar(2048) NULL | | |
| `scriptLength` | bigint unsigned NULL | | |
| `scriptOffset` | bigint unsigned NULL | | |
| `lockingScript` | binary NULL | | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

**Uniqueness**: `(transactionId, vout, userId)` must be UNIQUE.

**Indexes** (required for spec-conformant performance):
- `(userId, spendable, outputId)`
- `(userId, basketId, spendable, outputId)`
- `(spentBy)`

**`UserUTXO` side-table prohibition**: Go's existing `user_utxos` table MUST be retired in v2. All spendability queries MUST read `outputs.spendable`. Rationale: §5.4.

### 1.3 `proven_tx_reqs`

Internal processing record. Drives broadcast, proof acquisition, and reorg recovery. **Not user-visible.**

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `provenTxReqId` | bigint, auto-increment | PK | |
| `provenTxId` | bigint NULL | FK → `proven_txs.provenTxId` | Linked after proof acquired |
| `status` | varchar(16) | NOT NULL, default `'unknown'`, indexed | See §2.2 |
| `attempts` | int unsigned | NOT NULL, default 0 | Proof-fetch attempts |
| `notified` | boolean | NOT NULL, default false | |
| `txid` | varchar(64) | NOT NULL, UNIQUE, indexed | |
| `batch` | varchar(64) NULL, indexed | | Batch broadcast grouping |
| `history` | longtext (JSON) | NOT NULL, default `'{}'` | Audit trail — §11 |
| `notify` | longtext (JSON) | NOT NULL, default `'{}'` | Notification subscribers |
| `rawTx` | binary | NOT NULL | |
| `inputBEEF` | binary NULL | | |
| `wasBroadcast` | boolean | NOT NULL, default false | First-broadcast latch (§6.4) |
| `rebroadcastAttempts` | int unsigned | NOT NULL, default 0 | Circuit-breaker counter (§6.4) |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

### 1.4 `proven_txs`

Finalized proof record. Append-only after creation, except for the `reproveHeader` reorg recovery path (§7).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `provenTxId` | bigint, auto-increment | PK | |
| `txid` | varchar(64) | NOT NULL, UNIQUE | |
| `height` | int unsigned | NOT NULL | Block height |
| `index` | int unsigned | NOT NULL | Merkle path leaf offset (**0 ⇒ coinbase**, see §9) |
| `merklePath` | binary | NOT NULL | BUMP-encoded |
| `rawTx` | binary | NOT NULL | |
| `blockHash` | varchar(64) | NOT NULL | |
| `merkleRoot` | varchar(64) | NOT NULL | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

### 1.5 Other tables (carried unchanged from v1)

Both implementations must include, with TS column shapes: `users`, `certificates`, `certificate_fields`, `output_baskets`, `output_tags`, `output_tags_map`, `tx_labels`, `tx_labels_map`, `commissions`, `monitor_events`, `settings`, `sync_states`.

### 1.6 Schema invariants

- **No table may be added or removed** outside of a spec revision.
- **No column may be renamed.** A column rename is a breaking schema change.
- **No column type may change** in a way that loses information (e.g., bigint → int).
- **JSON-encoded columns** (`history`, `notify`) MUST be valid JSON conforming to the schemas in `pkg/wdk/history` (Go) / `src/sdk` (TS). The JSON shape itself is part of the spec.

---

## 2. Status Enums

Two enums. **Both implementations must use the exact same string values for both enums.**

### 2.1 `transactions.status` (`TransactionStatus`)

| Value | Meaning | User-visible? |
|---|---|---|
| `unsigned` | Created, awaiting signing. | yes |
| `unprocessed` | Signed, queued for storage actions. | yes |
| `nosend` | Signed, intentionally not broadcast. | yes |
| `sending` | Broadcast in progress or service-error retry. | yes |
| `unproven` | Broadcast accepted by ≥1 service; no proof yet. | yes |
| `nonfinal` | nLockTime in the future; not eligible for mining. | yes |
| `unfail` | Admin retry — see §8. | yes (internal label) |
| `failed` | Terminal: rejected by network or double-spent. | yes |
| `completed` | Terminal: proof acquired AND ≥`MinConfirmationDepth` blocks built on top. | yes |

**Rule (v2 new):** `completed` ⇒ `provenTxId` MUST be non-NULL.
**Rule (v2 new):** `failed` ⇒ all outputs of this tx MUST have `spendable=false` (§5.3).
**Rule (v1, retained):** A `completed` tx CANNOT be reverted to a non-`completed` status by `updateTransactionStatus`. **Exception:** the reorg recovery path defined in §7 MAY revert `completed` → `unproven`.

### 2.2 `proven_tx_reqs.status` (`ProvenTxReqStatus`)

| Value | Meaning |
|---|---|
| `unsent` | Queued for first broadcast. |
| `unprocessed` | Pre-broadcast holding state. |
| `nosend` | Will not be broadcast by this wallet. |
| `nonfinal` | Awaiting nLockTime maturity. |
| `unknown` | Status unresolvable. |
| `sending` | Broadcast attempt in flight or pending retry. |
| `unmined` | At least one broadcaster accepted; in mempool. |
| `callback` | Awaiting webhook/SSE confirmation from broadcaster. |
| `unconfirmed` | Proof acquired but block depth < `MinConfirmationDepth`. |
| `completed` | Terminal: proof acquired AND depth ≥ `MinConfirmationDepth`. |
| `invalid` | Terminal: rejected by all broadcasters. |
| `doubleSpend` | Terminal: confirmed double-spend. |
| `unfail` | Admin-initiated retry from a terminal failure. |

**v2 deletion:** The Go-only `reorg` value is REMOVED. Reorg processing reverts to `unconfirmed` (§7).
**v2 alignment:** The Go-only string `'invalidTx'` is REMOVED. Both implementations MUST use `'invalid'`.

### 2.3 Status mapping (req ↔ tx)

When a `proven_tx_reqs.status` transitions, the linked `transactions.status` MUST be updated atomically per this table:

| `proven_tx_reqs.status` → | `transactions.status` |
|---|---|
| `unsent`, `unprocessed`, `nosend`, `nonfinal` | `nosend` or `unsigned` (initial) |
| `sending` | `sending` |
| `unmined`, `callback`, `unconfirmed` | `unproven` |
| `completed` | `completed` |
| `invalid`, `doubleSpend` | `failed` |
| `unfail` | `unproven` (after successful unfail) or `failed` (after failed unfail) |
| `unknown` | preserved |

---

## 3. Configuration constants

All implementations MUST expose these as configurable, with the listed defaults:

| Constant | Default | Description |
|---|---|---|
| `MinConfirmationDepth` | `1` | Block depth required for `completed`. (`tipHeight - blockHeight >= MinConfirmationDepth`) |
| `CoinbaseMaturity` | `100` | Block depth required before coinbase outputs are spendable. |
| `MaxProofAttempts` (`MaxAttempts` in Go) | `100` | Per-tx attempts to fetch proof before circuit-breaker kicks in. |
| `MaxRebroadcastAttempts` | `0` (unlimited) | Cycles of rebroadcast after proof timeout. |
| `CheckNoSendPeriodHours` | `24` | Frequency of `nosend` proof check (in case tx was broadcast externally). |
| `FailAbandonedAgeSeconds` | impl-defined, ≥3600 | Age before unprocessed tx is failed. |
| `BroadcastSoftTimeoutMs` | `5000` | Per-provider broadcast timeout in sequential fallback. |
| `BroadcastSoftTimeoutPerKbMs` | `50` | Additional per-KiB budget. |
| `BroadcastSoftTimeoutMaxMs` | `30000` | Upper bound. |
| `ReorgAgeMsecs` | `600000` | Wait before processing a deactivated header. |
| `ReorgMaxRetries` | `3` | Reprove retry budget per orphaned block. |

---

## 4. Transaction Lifecycle (Finite State Machine)

### 4.1 `transactions.status` FSM

```
        ┌─────────┐
        │unsigned │  (createAction)
        └────┬────┘
             │ sign
             ▼
        ┌─────────────┐
        │unprocessed  │
        └────┬────────┘
   ──────┬───┴──────────────────────┐
   │     │                          │
   ▼     ▼                          ▼
 nosend  sending ◄─── service-err   nonfinal (nLockTime > now)
   │       │                          │
   │       │ broadcast accepted        │ time reached
   │       ▼                          │
   │     unproven ◄──────────────────┘
   │       │
   │       │ proof @ depth ≥ MinConfirmationDepth
   │       ▼
   │     completed (terminal*)
   │       
   │     ┌──────────────┐
   └────►│  failed      │ (terminal**)
         │  (invalid /  │
         │  doubleSpend)│
         └──────┬───────┘
                │ unfail (admin)
                ▼
              unproven (retry) or failed (still bad)
```

\* `completed` may revert to `unproven` ONLY via the reorg path (§7).
\** `failed` may transition to `unfail`, which is itself a transient retry state and resolves back to either `unproven` or `failed`.

### 4.2 `proven_tx_reqs.status` FSM

```
                    ┌──────┐
                    │unsent│ (createAction signed / internalize unconfirmed)
                    └───┬──┘
            ┌───────────┴────────────┐
            ▼                        ▼
        ┌──────┐                ┌────────┐
        │nosend│                │sending │ ◄─── serviceError
        └───┬──┘                └───┬────┘
            │                        │
            │  (nosend may also      │ all-services-success
            │   reach proof if       ▼
            │   broadcast            ┌────────┐
            │   externally)          │unmined │
            │                        └───┬────┘
            │                            │ callback subscribed
            │                            ▼
            │                        ┌─────────┐
            │                        │callback │
            │                        └────┬────┘
            │                             │ proof acquired
            │                             ▼
            │                       ┌────────────┐
            │                       │unconfirmed │ (depth < MinConfirmationDepth)
            │                       └─────┬──────┘
            │                             │ depth reaches MinConfirmationDepth
            │                             ▼
            │                       ┌──────────┐
            └──────► proof ───────► │completed │ (terminal)
                                    └──────────┘

  Any non-terminal → invalid (after all broadcast attempts fail)
  Any non-terminal → doubleSpend (confirmed conflict)
  invalid | doubleSpend → unfail (admin) → unmined (proof found) | invalid (still failing)
```

### 4.3 Allowed transitions table (testable)

The following table enumerates **every legal** transition. Anything else is an error. Implementations MUST reject illegal transitions with a typed error (`WERR_INVALID_OPERATION` in TS, equivalent in Go).

#### `transactions.status` legal transitions

| From | To | Trigger |
|---|---|---|
| `unsigned` | `unprocessed` | sign |
| `unsigned` | `failed` | abort/abandon |
| `unprocessed` | `nosend` | noSend flag |
| `unprocessed` | `sending` | broadcast start |
| `unprocessed` | `nonfinal` | nLockTime future |
| `unprocessed` | `failed` | abort/abandon |
| `sending` | `unproven` | aggregated success |
| `sending` | `failed` | invalid / doubleSpend |
| `sending` | `sending` | serviceError retry |
| `unproven` | `unproven` | reorg → reproved at new depth |
| `unproven` | `completed` | proof at depth ≥ `MinConfirmationDepth` |
| `unproven` | `failed` | confirmed doubleSpend during sync |
| `nonfinal` | `unprocessed` | nLockTime reached |
| `nonfinal` | `failed` | abandoned |
| `nosend` | `unproven` | external broadcast detected |
| `nosend` | `completed` | external broadcast + proof |
| `nosend` | `failed` | explicit failure |
| `completed` | `unproven` | **reorg path only** (§7) |
| `failed` | `unfail` | admin |
| `unfail` | `unproven` | proof found during unfail |
| `unfail` | `failed` | proof not found |

#### `proven_tx_reqs.status` legal transitions

(Driven by monitor tasks; user code does not directly transition.)

| From | To | Trigger |
|---|---|---|
| `unsent` | `sending` | broadcast attempt |
| `sending` | `unmined` | aggregated success |
| `sending` | `invalid` | all-providers reject (statusError) |
| `sending` | `doubleSpend` | confirmed conflict |
| `sending` | `sending` | serviceError retry |
| `unmined` | `callback` | callback subscription |
| `unmined`/`callback` | `unconfirmed` | proof found, depth < `MinConfirmationDepth` |
| `unconfirmed` | `completed` | depth reaches `MinConfirmationDepth` |
| `unconfirmed` | `unconfirmed` | reorg — clear proof, retry (depth resets) |
| `completed` | `unconfirmed` | **reorg only** (§7) |
| `invalid`/`doubleSpend` | `unfail` | admin |
| `unfail` | `unmined` | proof found |
| `unfail` | `invalid` | no proof |
| `unmined`/`callback` | `unsent` | rebroadcast cycle (`MaxProofAttempts` reached, under `MaxRebroadcastAttempts` budget) |
| `nosend` | `completed`/`unmined`/`invalid` | via `TaskCheckNoSends` if externally broadcast |

---

## 5. Output spendability rules

### 5.1 Authoritative flag

`outputs.spendable` is the **only** authoritative signal of UTXO availability. Every input-selection path MUST query this flag and MUST NOT rely on a side index (this is why §1.2 mandates retirement of `user_utxos`).

### 5.2 Setting `spendable = true`

`outputs.spendable` MUST be set to true exactly when **all** of the following are true:

1. The owning tx's status is in `{ unproven, completed }` **OR** the output is being created by `internalizeAction` with a proof at any depth.
2. The output is NOT a coinbase output below `CoinbaseMaturity` depth (§9).
3. The output's `spentBy` is NULL.
4. `lockingScript` is present and parses as a valid script.

### 5.3 Setting `spendable = false` (terminal transitions)

When `transactions.status` transitions to `failed` (whether triggered by `invalid` or `doubleSpend` on the linked req), the implementation MUST, **atomically with the status update**:

1. Set `spendable = false` on **every** output owned by this transaction.
2. Restore each input this tx consumed: set the prior output's `spendable = true` and clear its `spentBy`, **iff** the prior output still belongs to a tx in a non-terminal status.

### 5.4 Why no `UserUTXO` side table

Two parallel sources of truth diverge under failure. The Go implementation's `user_utxos` index produces "implicit" toxicity (a failed tx's outputs lack a UTXO row, so they cannot be selected) only when **every** input-selection path consults `UserUTXO`. A single bug elsewhere that reads `outputs.spendable` directly silently re-enables toxic outputs. v2 fixes this by collapsing to one column.

### 5.5 Coinbase outputs

See §9.

### 5.6 Reorg

See §7. Reorg MUST NOT flip output `spendable` values.

---

## 6. Self-created transactions (`createAction` / `signAction` / process)

### 6.1 Required progression

1. `createAction` inserts `transactions` row with `status='unsigned'`, allocates inputs (setting consumed `outputs.spendable=false`, `spentBy=this.transactionId`) and inserts unsigned change outputs with `spendable=false`.
2. `signAction` completes signing and transitions `status` to `unprocessed`.
3. Process orchestrator transitions to `sending` and inserts/updates the `proven_tx_reqs` row with `status='unsent'`.
4. Broadcast (§6.2) updates both rows per §2.3.
5. On aggregated `success`: change outputs are flipped to `spendable=true` atomically with the status update; `req.wasBroadcast=true`.
6. Sync task acquires proof, transitions through `unconfirmed` → `completed`.

### 6.2 Broadcast service ordering — SEQUENTIAL FALLBACK MANDATORY

Implementations MUST broadcast to one provider at a time, in priority order (ARC providers first, then secondary), with the following protocol:

```
for provider in providers:
    result = call provider with BroadcastSoftTimeoutMs + perKb adjustment
    if result == success:
        break
    if result == doubleSpend:
        break  # confirmed double-spend
    if result == invalid (status error):
        record; continue
    if result == serviceError or timeout:
        moveToBackOfQueue; continue
```

**Parallel broadcast is FORBIDDEN.** Existing TS `postBeefMode = 'PromiseAll'` is REMOVED in v2. Existing Go `PostFromBEEF` parallel `.All` is RE-IMPLEMENTED as sequential `OneByOne`.

### 6.3 Aggregation rules (mixed results)

After all providers responded (or sequential loop exited):

- If `successCount >= 1` and `doubleSpendCount == 0` → **success**.
- If `successCount >= 1` and `doubleSpendCount >= 1` → **success** (positive wins; the doubleSpend report is logged as discrepancy in `history`). **v2 fix**: BOTH implementations previously preferred doubleSpend. This is reversed.
- If `successCount == 0` and `doubleSpendCount >= 1` → **doubleSpend** → confirm via secondary lookup (`getStatusForTxids`); only mark terminal `doubleSpend` after confirmation.
- If `successCount == 0` and `doubleSpendCount == 0` and `statusErrorCount >= 1` and `serviceErrorCount == 0` → **invalid**.
- If `serviceErrorCount >= 1` and no successes → **serviceError** → retry (`req.status` stays `sending`, `attempts++`).

A `serviceError`-only outcome does NOT mark `invalid`. Invalid requires all attempted providers to return a non-service-error status rejection.

### 6.4 Rebroadcast and circuit-breaker

- After `MaxProofAttempts` proof-fetch failures with `req.wasBroadcast == true`, if `req.rebroadcastAttempts < MaxRebroadcastAttempts`, reset `req.status = 'unsent'` and increment `rebroadcastAttempts`.
- If `req.rebroadcastAttempts >= MaxRebroadcastAttempts`, mark `req.status = 'invalid'`, `tx.status = 'failed'`, apply §5.3.
- If `req.wasBroadcast == false` after `MaxProofAttempts`, mark `invalid`/`failed` immediately (the tx was never accepted by anyone).

---

## 7. Reorganization handling

### 7.1 Detection

A reorg is detected by chaintracks providing a `deactivatedHeaders` list (TS Monitor) or a `OnReorg` event (Go monitor). Both implementations MUST surface these as a unified `reorg` pipeline.

### 7.2 Action

For each orphaned block hash:

1. **Find all affected proven_txs:** `WHERE blockHash IN (orphanedHashes)`.
2. **Find all linked transactions** with `provenTxId` pointing to those `proven_txs` rows.
3. **Atomically**, for each affected tx:
   - Set `proven_tx_reqs.status` ← `unconfirmed` and clear `provenTxId` from the req row.
   - Set `transactions.status` ← `unproven`.
   - **Preserve** `outputs.spendable` values (do NOT flip).
   - Add a `history` note `reorgInvalidatedProof(blockHash)`.
4. Schedule reprove (subject to `ReorgAgeMsecs` delay, `ReorgMaxRetries` budget).
5. If reprove finds a new merkle path within retry budget → re-acquire proof through normal `unconfirmed` → `completed` path.
6. If reprove fails for all retries → req remains `unconfirmed`; sync task continues polling via standard `MaxProofAttempts` path.

### 7.3 Forbidden reorg outcomes

A reorg MUST NEVER:

- Mark a tx `failed`/`invalid`/`doubleSpend` purely on the basis of the reorg event.
- Set any output's `spendable` to false.
- Skip the depth-gate when re-promoting the reproved tx to `completed`.

**Exception (coinbase reorg, §9.6):** if the orphaned block was a coinbase the wallet held, the coinbase output may be marked non-spendable; see §9.

### 7.4 No `reorg` status value

The transient `reorg` value present in current Go is replaced by the canonical `unconfirmed` value with a `history` note. This keeps the FSM minimal and matches TS semantics.

---

## 8. Third-party transactions (`internalizeAction`)

### 8.1 Two paths

#### 8.1.1 BEEF with merkle proof

1. Verify scripts and validate BUMP against local chaintracks. **If validation fails, abort and do NOT persist.**
2. Compute depth: `tipHeight - bump.blockHeight`.
3. Atomic insert:
   - `transactions.status = 'unproven'` initially.
   - `proven_tx_reqs.status = 'unmined'`.
   - Outputs: `spendable = true` (unless coinbase per §9).
4. Call `updateKnownTxAsMined` which links a `proven_txs` row.
5. **Depth gate:** if `depth >= MinConfirmationDepth`, promote to `completed` (both `transactions.status` and `proven_tx_reqs.status`). If `depth < MinConfirmationDepth`, set `proven_tx_reqs.status = 'unconfirmed'`, leave `transactions.status = 'unproven'`. The next sync cycle promotes to `completed` once depth is met.

**v2 fix vs current Go:** Go currently bypasses the depth gate on internalize. Must apply the same gate.

#### 8.1.2 BEEF without merkle proof

1. Verify scripts. Atomic insert with `transactions.status='unproven'`, `proven_tx_reqs.status='unsent'`, outputs `spendable=true` (unless coinbase).
2. **Within the same database transaction**, attempt sequential broadcast via §6.2.
3. If broadcast aggregated `success` → commit; transition req to `unmined`.
4. If broadcast aggregated `doubleSpend` → **rollback the entire insert**; return `WERR_REVIEW_ACTIONS` to the caller with the competing-tx info.
5. If broadcast aggregated `invalid` → **rollback** and return `WERR_REVIEW_ACTIONS`.
6. If broadcast aggregated `serviceError` → commit, leave req as `unsent` for retry by `SendWaiting` task. Document this to callers.

**v2 fix vs current TS/Go:** TS leaves partial rows on broadcast failure; Go does not broadcast at internalize time. Both are non-conformant.

### 8.2 Idempotency

If a txid already exists for the user:
- If existing `transactions.status` ∈ `{ completed, unproven, nosend }` → merge: add new outputs (basket insertions / wallet payments) and labels; do not change status.
- If existing status is `failed` → reject with `WERR_INVALID_PARAMETER`.

---

## 9. Coinbase transactions

### 9.1 Detection

A transaction is a **coinbase** iff its merkle path leaf offset is `0` (i.e., `proven_txs.index == 0`). This is the only canonical detector. No other heuristic (input-zero check, dummy-prev-out hash) is required, but implementations MAY add additional verification.

### 9.2 Maturity

A coinbase output is **non-spendable** until `tipHeight - proven_txs.height >= CoinbaseMaturity` (default 100). This rule applies regardless of `transactions.status`.

### 9.3 Required behaviors

- On insertion (`internalizeAction` with proof + offset 0): set output `spendable=false`, even if `transactions.status=completed`.
- During the periodic sync cycle, for every coinbase output owned by the user, recompute maturity; once `depth >= CoinbaseMaturity`, set `spendable=true` (subject to §5.2 conditions).
- A new task `TaskCoinbaseMaturity` MUST run on every new-block tick (or piggybacks `TaskCheckForProofs`) and emit the spendability flips.

### 9.4 Storage

The `proven_txs.index` column already stores the leaf offset; no schema addition is required. Implementations SHOULD add an index on `(provenTxId)` joined to `transactions` for efficient maturity scans.

### 9.5 Coinbase listing

`listOutputs` MUST NOT return coinbase outputs as spendable until matured, even when `includeSpent=false` is requested with no other filter.

### 9.6 Coinbase reorg

If a coinbase tx the wallet holds is orphaned by a reorg AND the new chain does not include it at any height, the wallet MUST:

1. Set `proven_tx_reqs.status = 'unconfirmed'` and clear `provenTxId` (standard reorg path).
2. After `ReorgMaxRetries` failed reproves, mark the tx `failed` and all outputs `spendable=false`. **This is the one allowed terminal failure on reorg.** A history note `coinbaseLost(originalBlockHash)` MUST be added.

This is the single exception to §7.3.

---

## 10. Atomicity & ordering

### 10.1 Required atomic units

Each of the following operations MUST execute inside a single DB transaction:

1. `createAction`: insert tx + allocate inputs + insert change outputs.
2. `signAction`: tx status change + raw tx write.
3. `processAction` broadcast result: req status + tx status + output spendability changes + `proven_txs` insert (if applicable) + history note.
4. `internalizeAction` (proof path): tx insert + req insert + outputs insert + proven_tx insert + status promotion (if depth met).
5. `internalizeAction` (no-proof path): see §8.1.2 — insert + broadcast outcome must be one atomic unit; rollback on bad outcome.
6. Reorg handling: req status revert + tx status revert + history note across all affected txs.
7. Coinbase maturity flip: per-output spendable flip + history note.
8. Unfail (§11) — single unit.

### 10.2 Ordering of writes within a transaction

Within each transaction, writes MUST occur in this order to keep the schema consistent for triggers and indexes:

1. `proven_txs` insert/update.
2. `proven_tx_reqs` status/columns.
3. `transactions` status/columns.
4. `outputs` spendable/spentBy flips.
5. History notes (`proven_tx_reqs.history` JSON append).

### 10.3 Isolation

Implementations MUST use at minimum READ COMMITTED isolation. SQLite is treated as SERIALIZABLE.

---

## 11. Admin operations

### 11.1 `unfail`

Setting `proven_tx_reqs.status = 'unfail'` is admin-only. The unfail processor MUST:

1. Attempt `services.getMerklePath(txid)`.
2. **If proof found and depth ≥ `MinConfirmationDepth`:**
   - Promote req → `completed`, tx → `completed`.
   - Link/create `proven_txs` row.
   - **No output changes** beyond what is implied by the standard `unproven → completed` promotion (which is a no-op for outputs, since `spendable` was already true in `unproven`).
3. **If proof found and depth < `MinConfirmationDepth`:**
   - req → `unconfirmed`, tx → `unproven`.
   - Sync task promotes later.
4. **If no proof:**
   - req → `invalid`, tx → `failed`.
   - Apply §5.3 (mark outputs unspendable, restore inputs).

**v2 fix vs current behavior:** Both implementations currently mutate output spendable state during unfail. v2 forbids this except via the standard FSM transitions in §4.3. Specifically: do not call `CreateUTXOForSpendableOutputsByTxID` or its TS equivalent (`isUtxo`-driven flip) from the unfail path.

### 11.2 History audit log

Every transition listed in §4.3 MUST append a JSON note to `proven_tx_reqs.history` with the schema:

```json
{
  "when": "<ISO-8601 timestamp>",
  "what": "<event tag>",
  "from": "<prior status>",
  "to": "<new status>",
  "by": "<actor: 'monitor:<task>' | 'user:<userId>' | 'admin' | 'system'>",
  "...details": "..."
}
```

Both implementations MUST emit identical `what` tags for identical events. Canonical list:

| `what` | When |
|---|---|
| `createAction` | row creation |
| `signAction` | signing complete |
| `attemptToPostReqsToNetwork` | broadcast batch start |
| `postBeefError` | individual provider error |
| `aggregateResults` | post-broadcast aggregation |
| `getMerklePathSuccess` | proof acquired |
| `getMerklePathNotFound` | sync miss |
| `notifyTxOfProof` | proof linked to tx |
| `internalizeAction` | third-party insert |
| `processAction` | wallet-driven status change |
| `reorgInvalidatedProof` | reorg detected |
| `reproveSuccess` | new merkle path after reorg |
| `reproveExhausted` | retries exhausted |
| `coinbaseMatured` | spendability flip |
| `coinbaseLost` | reorg-induced terminal failure (§9.6) |
| `unfail*` | each unfail decision |
| `rebroadcastCycle` | circuit-breaker cycle |
| `failedToInvalid` | rebroadcast budget exhausted |

---

## 12. Monitor tasks (canonical set)

Both implementations MUST run the following tasks. Cadences are minimums; implementations MAY run more often.

| Task | Cadence | Behavior |
|---|---|---|
| `NewHeader` | poll every ≤60s | Detect new chain tip; trigger proof solicitation; detect reorg via deactivated headers. |
| `CheckForProofs` | on new header | For each non-terminal `req`, fetch merkle path, evaluate depth, promote per §4.2. |
| `SendWaiting` | every ≤5 min | Broadcast `req.status='unsent'` rows per §6.2. |
| `FailAbandoned` | every ≤1 hour | Mark `unsigned`/`unprocessed` older than `FailAbandonedAgeSeconds` as `failed`. |
| `Reorg` | when deactivated headers present, after `ReorgAgeMsecs` delay | Per §7. |
| `CoinbaseMaturity` | on new header (may piggyback `CheckForProofs`) | Per §9.3. |
| `CheckNoSends` | every `CheckNoSendPeriodHours` | Re-check `nosend` rows for external broadcast. |
| `UnFail` | every ≤10 min | Per §11.1. |
| `Purge` | configurable (e.g., daily) | Optional cleanup of expired terminal rows. |

The Go-only `OnReorg` event handler is merged into the `Reorg` task to keep the task surface identical.

---

## 13. Testable conformance checklist

Each implementation MUST have a named test for each of the following scenarios. Test names are normative — they form the conformance suite.

### 13.1 Happy paths

- `T_HAPPY_01_self_created_to_completed` — createAction → broadcast → proof → unconfirmed → completed; outputs spendable at `unproven`.
- `T_HAPPY_02_internalize_proof_deep` — internalize with proof, depth ≥ `MinConfirmationDepth` → completed.
- `T_HAPPY_03_internalize_proof_tip` — internalize with proof at tip → unconfirmed → completed after one block.
- `T_HAPPY_04_internalize_no_proof_broadcast_ok` — internalize without proof + successful self-broadcast → unproven.

### 13.2 Failure paths

- `T_FAIL_01_all_providers_reject_invalid` — all broadcasters return status-error → req `invalid`, tx `failed`, outputs unspendable.
- `T_FAIL_02_serviceError_does_not_fail` — all broadcasters return service-error → req stays `sending`, tx stays `sending`, outputs unchanged.
- `T_FAIL_03_doubleSpend_after_confirm` — broadcaster reports doubleSpend, secondary lookup confirms → req `doubleSpend`, tx `failed`.
- `T_FAIL_04_internalize_invalid_discards` — internalize without proof + broadcast invalid → no rows persisted, error returned.
- `T_FAIL_05_internalize_doubleSpend_discards` — same with doubleSpend.

### 13.3 Mixed results

- `T_MIXED_01_success_and_doubleSpend_trusts_success` — provider A success, provider B doubleSpend → req `unmined`, tx `unproven`, `history` records discrepancy.

### 13.4 Reorg

- `T_REORG_01_completed_reverts_to_unproven` — orphaned block hosting our completed tx → req `unconfirmed`, tx `unproven`, outputs preserved.
- `T_REORG_02_reproven_returns_to_completed` — reproven on new chain at sufficient depth → req `completed`, tx `completed`.
- `T_REORG_03_reorg_never_marks_invalid` — orphaned without re-mining → req stays `unconfirmed`, tx stays `unproven`.
- `T_REORG_04_outputs_preserved_through_reorg` — output spendable values do not change at any point in the reorg cycle.

### 13.5 Coinbase

- `T_COINBASE_01_offset_zero_detected` — `proven_txs.index == 0` ⇒ `outputs.spendable = false` regardless of tx status.
- `T_COINBASE_02_matures_at_100` — exactly at depth 100, output flips to spendable.
- `T_COINBASE_03_premature_not_in_listOutputs` — `listOutputs` does not return immature coinbase outputs.
- `T_COINBASE_04_reorg_loss_terminal` — orphaned coinbase, retries exhausted → tx `failed`, outputs unspendable, `coinbaseLost` history note.

### 13.6 Output spendability invariants

- `T_OUTPUT_01_failed_tx_all_outputs_unspendable` — after `tx.status=failed`, every output of the tx has `spendable=false` (no implicit absence — explicit flag).
- `T_OUTPUT_02_failed_tx_inputs_restored` — after `tx.status=failed`, every input the tx consumed has `spendable=true` and `spentBy=NULL`, provided the prior tx is still non-terminal.
- `T_OUTPUT_03_unfail_does_not_modify_outputs` — `unfail` transition does not produce any update to `outputs.spendable`, `outputs.spentBy`, or `outputs.spendingDescription` beyond what §4.3 specifies for the resulting status.
- `T_OUTPUT_04_only_spendable_column_consulted` — input selection paths grep clean of any reads against `user_utxos` (Go) or any side-index of UTXO state.

### 13.7 Schema parity

- `T_SCHEMA_01_ts_writes_go_reads` — A SQLite file created and populated by the TS wallet must be openable by the Go wallet, all migrations applied, and `listActions` / `listOutputs` returning equivalent results.
- `T_SCHEMA_02_go_writes_ts_reads` — converse.
- `T_SCHEMA_03_column_inventory_identical` — both implementations report identical column lists (name, type-class, nullability) for every table in §1.
- `T_SCHEMA_04_no_user_utxos_table` — Go test asserts `user_utxos` table is absent post-migration.

### 13.8 Status string parity

- `T_STATUS_01_invalid_string` — both implementations write the literal `'invalid'` (not `'invalidTx'`) to `proven_tx_reqs.status`.
- `T_STATUS_02_no_reorg_status` — neither implementation writes `'reorg'` to `proven_tx_reqs.status`.

### 13.9 Atomicity

- `T_ATOMIC_01_broadcast_rollback_on_panic` — a panic between broadcast and storage update leaves no inconsistent rows.
- `T_ATOMIC_02_internalize_rollback_on_bad_broadcast` — §8.1.2 rollback path verified.

### 13.10 Configuration

- `T_CONF_01_min_confirmation_depth_honored` — at `MinConfirmationDepth=3`, tx with proof at depth 2 stays `unconfirmed`; at depth 3, promotes to `completed`.
- `T_CONF_02_coinbase_maturity_configurable` — at `CoinbaseMaturity=10`, coinbase outputs flip at depth 10.

### 13.11 Mutual cross-implementation suite

- `T_CROSS_01` — TS-broadcast tx, Go-monitor completes it.
- `T_CROSS_02` — Go-broadcast tx, TS-monitor completes it.
- `T_CROSS_03` — Both monitors running concurrently against the same DB do not corrupt state (advisory locking required; see §14).

---

## 14. Concurrency & dual-runtime operation

### 14.1 Single-writer assumption

For v2, only ONE wallet runtime (TS or Go) may be the active writer at any time. The settings table SHOULD record `activeStorage` identity to make this explicit; processes that find a foreign `activeStorage` MUST refuse writes.

### 14.2 Cross-runtime switchover

To switch from TS to Go (or vice versa):

1. Stop the active wallet runtime.
2. Wait ≥`max(NewHeader cadence, SendWaiting cadence)` for in-flight work to drain.
3. Update `settings.activeStorage` to the new runtime's identity key.
4. Start the new runtime.

A future v3 may add multi-writer support with a leader-election scheme. v2 deliberately constrains to single-writer to keep the FSM auditable.

### 14.3 Same-runtime concurrency

Within a single runtime, monitor tasks MAY run concurrently iff they target disjoint row sets. Tasks that share rows (e.g., `CheckForProofs` + `SendWaiting`) MUST use a process-local mutex (TS: in-memory; Go: `sync.Mutex` already present in `synchronizeTxStatuses`).

---

## 15. Migration plan from current state

### 15.1 TS implementation changes

1. **Sequential broadcast only.** Remove `PromiseAll` mode from `Services.postBeefMode`.
2. **Mixed-result aggregation reversal.** Reorder aggregator: success > doubleSpend (currently doubleSpend > success).
3. **Failed-tx outputs.** Add explicit walk in `updateTransactionStatus`'s `case 'failed'` to set `outputs.spendable=false` on the tx's own outputs.
4. **Internalize atomicity.** Wrap insert + broadcast in a single `storage.transaction(...)` for the no-proof path; rollback on bad broadcast outcome.
5. **Reorg revert.** Remove the `updateTransactionStatus` hard block on de-completing for reorg paths. Allow `completed → unproven` via a new `revertCompletedForReorg` storage method.
6. **Coinbase maturity.** Add `TaskCoinbaseMaturity`. Add §9.5 filter to `listOutputs`.
7. **Unfail must not modify outputs.** Strip `unfailReq` of input/output mutation; rely on the standard `updateTransactionStatus` paths.
8. **Internalize depth gate.** Apply §8.1.1 depth check.

### 15.2 Go implementation changes

1. **Sequential broadcast.** Replace `postEFServices.All` / `postTXServices.All` with `OneByOne`-style sequential helpers.
2. **Mixed-result aggregation reversal.** Same as TS.
3. **Failed-tx outputs.** `RecreateSpentOutputs` extended (or new method) to walk and flip the tx's own outputs.
4. **Internalize atomicity + broadcast inline.** Add inline broadcast to internalize's no-proof path; rollback on bad outcome.
5. **Reorg revert Transactions.** `InvalidateMerkleProofsByBlockHash` extended to also update `transactions.status = unproven`. The `reorg` enum value is dropped.
6. **Coinbase maturity.** Implement §9 from scratch.
7. **Unfail must not modify outputs.** Remove `CreateUTXOForSpendableOutputsByTxID` from `markAsUnminedAndUnproven`.
8. **Internalize depth gate.** `updateKnownTxAsMined` must check depth before setting `completed`.
9. **Schema reconciliation: drop `user_utxos`.** A migration that copies UTXO-status flags into `outputs.spendable` and drops the side table.
10. **Status string alignment.** Migrate `invalidTx` → `invalid`, `reorg` → `unconfirmed` (with a `history` note).
11. **Monitor task additions.** Add `NewHeader`, `Reorg` (task form), `CoinbaseMaturity`, `CheckNoSends`, `Purge`. `OnReorg` event handler folded into `Reorg`.

### 15.3 Migration ordering

The Go schema migration runs first (drops `user_utxos`, renames `invalidTx`→`invalid`, `reorg`→`unconfirmed`). Then both runtimes ship v2 code simultaneously. The conformance test suite §13 must pass on both before either is promoted.

---

## 16. Out of scope for v2

- Multi-writer concurrency on a shared DB (v3).
- Sharding / horizontal partitioning (v3).
- BRC-100 wire protocol changes (governed elsewhere).
- New transaction types beyond what BRC-100 defines.
- Alternative storage backends beyond SQLite / MySQL / Postgres / IndexedDB.

---

## 17. Glossary

| Term | Definition |
|---|---|
| **Action** | High-level BRC-100 transaction intent. |
| **BEEF** | BSV Extended Element Format — tx with merkle proof envelope (BRC-62). |
| **BUMP** | BSV Unified Merkle Path (BRC-74). |
| **chaintracks** | Block header tracking service. |
| **completed** | Terminal happy-path status — proof acquired AND depth ≥ `MinConfirmationDepth`. |
| **coinbase** | Block-reward transaction; first tx in a block; merkle offset 0. |
| **doubleSpend** | Terminal failure: an input was spent by a competing confirmed tx. |
| **invalid** | Terminal failure: tx was rejected by all broadcasters. |
| **`MinConfirmationDepth`** | Block depth required for `completed`. Default 1. |
| **`CoinbaseMaturity`** | Block depth required for coinbase outputs to be spendable. Default 100. |
| **req** | Shorthand for `proven_tx_reqs` row (the processing record). |
| **tip** | Highest block in the active chain at a given moment. |
| **toxic output** | Output that must never be selected as an input. Represented by `spendable=false`. |

---

**End of PROD_REQ_V2.md.**
