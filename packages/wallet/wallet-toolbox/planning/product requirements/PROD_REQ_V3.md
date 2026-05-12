# PROD_REQ_V3.md — BSV Wallet UTXO & Transaction Lifecycle Specification

**Version:** 3.0
**Date:** 2026-05-11
**Status:** Draft — designed for cross-implementation parity between `@bsv/wallet-toolbox` (TypeScript) and `go-wallet-toolbox` (Go).

---

## 0. Philosophy

This is a clean-sheet specification. Neither the TypeScript nor the Go implementation is held canonical. Each has divergences from sound architecture; this document defines the target state. Both implementations migrate to it. Migration paths from each existing schema are provided in §16.

The design optimizes for:

1. **Correctness under reorg and concurrent monitor runs.** Money depends on this.
2. **Scale to ≥10⁸ outputs per wallet** without linear-time UTXO selection.
3. **Observability.** Every state transition is timestamped, attributed, and queryable.
4. **Implementation parity.** Schema names, status strings, FSM, and audit shape are byte-identical. A wallet DB written by either runtime works with the other.
5. **Forward compatibility.** Adding fields is a minor version; semantic changes are major. v3 → v4 must be plannable from this document.

---

## 1. Architectural overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Application                                                          │
│     │                                                                  │
│     ▼                                                                  │
│  Wallet API (BRC-100)                                                  │
│     │                                                                  │
│  ┌──┴────────────────────────────────────────────────────────────┐    │
│  │  Action orchestrators                                          │    │
│  │  createAction · signAction · internalizeAction · listOutputs   │    │
│  └──┬─────────────────────────────────────────────────────────────┘    │
│     │                                                                   │
│  ┌──┴──────────────────────────────────────────────────────────────┐   │
│  │  Storage (Knex / gorm / IDB — same schema, see §3)               │   │
│  └──┬──────────────────────────────────────────────────────────────┘   │
│     │                                                                    │
│  ┌──┴──────────────────────────────────────────────────────────────┐    │
│  │  Monitor (tasks, see §12)                                         │    │
│  │  Tip tracker · Proof fetcher · Broadcaster · Reorg handler ·      │    │
│  │  Maturity ticker · Notifier · Reaper                              │    │
│  └──┬──────────────────────────────────────────────────────────────┘    │
│     │                                                                    │
│  ┌──┴──────────────────────────────────────────────────────────────┐    │
│  │  Services (ARC, WoC, Bitails, chaintracks, BlockHeaderService)    │    │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Layering rules

- **Action layer** writes domain entities (`transactions`, `outputs`) inside DB transactions. Never calls services directly during a write.
- **Monitor layer** owns side-effecting service calls. Reads work-queue tables, calls services, commits result back inside another DB transaction.
- **Service layer** is stateless w.r.t. the wallet DB. It returns observations; it does not write.

This decoupling lets the action path stay <50 ms even when a broadcaster hangs.

### 1.2 Cardinality concerns

| Entity | Expected cardinality | Read pattern | Write pattern |
|---|---|---|---|
| Users | 10² – 10⁴ | by id | rare |
| Transactions | 10⁶ – 10⁹ per wallet | by id, by txid, by status, by tip-depth | append-heavy, status-update |
| Outputs | 10⁶ – 10⁹ per wallet | by user+spendable (selection), by id, by spentBy | append + flip |
| ProvenTxReqs | 10⁵ – 10⁷ | by status (worker queue) | status-update |
| ProvenTxs | 10⁶ – 10⁸ | by txid, by height | append-only (+ reorg) |

Implication: the hot path is "give me N spendable outputs for user X in basket Y of at least Z sats." This must be a single index seek, not a table scan.

---

## 2. Domain model & invariants

### 2.1 Two-layer status, formalized

Wallet state is described by **two coupled FSMs**:

1. **`tx.lifecycle`** — what the application sees (analogous to TS `TransactionStatus`).
2. **`tx.processing`** — what the monitor is doing (analogous to TS `ProvenTxReqStatus`).

These FSMs are co-located in one row in v3 (see §3.1) but remain logically distinct. Coupling rules are listed in §5.

Rationale for keeping two FSMs but collapsing the rows: every existing implementation already maintains them. Splitting across two physical tables (current TS) costs an extra join on every list query; merging into one row (current Go `known_txs`) couples user-visible status mutations with monitor mutations in the same row. v3 takes the middle path: one row, two columns. Updates to `processing` are isolated by `(processing, attempts, processing_version)` to avoid stomping on `lifecycle` updates and vice versa.

### 2.2 Output spendability — single source of truth, two derived indices

`outputs.spendable` remains the single boolean source of truth for whether an output can be selected as an input.

**Spendability is not directly stored — it is a function of three observable columns:**

```
spendable = (status_is_active) AND (NOT is_coinbase OR tip_height >= matures_at_height) AND (spent_by IS NULL)
```

The column `outputs.spendable` is a **denormalized cache** of this function, refreshed atomically by every transition that changes any input. It exists for index speed. The derivation is reproducible by anyone reading the row — implementations MUST include a periodic reconciliation task (§12) that flags any row where the cached `spendable` disagrees with the derivation.

### 2.3 Idempotency keys

Every write that calls an external service (broadcast, proof fetch) carries an **idempotency key** generated at the action layer. Retries reuse the same key. Providers that honor the key (ARC) deduplicate at their end; providers that don't are detected by us comparing returned txids.

### 2.4 Optimistic concurrency control

Every row in `transactions`, `proven_tx_reqs`, `outputs` carries a monotonic `row_version` integer. Every update statement includes `WHERE row_version = ?` and increments. Concurrent monitor instances detect lost-update races and retry. This replaces (or augments, depending on the dialect) advisory locks.

---

## 3. Canonical schema (v3)

Both implementations MUST realize this schema. Column names, types, constraints, and indexes are normative. Implementations MAY add additional indexes; they MUST NOT remove any normative index.

### 3.1 `transactions`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `transactionId` | bigint, auto-inc | PK | |
| `userId` | bigint | FK → users, NOT NULL, indexed | |
| `provenTxId` | bigint NULL | FK → proven_txs | Set when proof first acquired |
| `txid` | varchar(64) NULL | indexed | Computed once signed |
| `reference` | varchar(64) | NOT NULL, UNIQUE | Random base64 token |
| `lifecycle` | varchar(20) | NOT NULL, indexed | §4.1 |
| `processing` | varchar(20) | NOT NULL, indexed | §4.2 |
| `row_version` | bigint | NOT NULL, default 0 | §2.4 |
| `idempotency_key` | varchar(64) NULL | indexed | §2.3 |
| `is_outgoing` | boolean | NOT NULL | |
| `is_coinbase` | boolean | NOT NULL, default false | Cached from `proven_txs.index == 0` |
| `satoshis_delta` | bigint | NOT NULL, default 0 | Net wallet delta |
| `version` | int unsigned NULL | | tx.version |
| `lock_time` | int unsigned NULL | | tx.lockTime |
| `description` | varchar(2048) | NOT NULL | |
| `input_beef` | binary NULL | | |
| `raw_tx` | binary NULL | | |
| `lifecycle_changed_at` | datetime | NOT NULL | Updated on every `lifecycle` change |
| `processing_changed_at` | datetime | NOT NULL | Updated on every `processing` change |
| `next_action_at` | datetime NULL | indexed | When monitor should next look at this row |
| `attempts` | int unsigned | NOT NULL, default 0 | Proof-fetch attempts |
| `rebroadcast_cycles` | int unsigned | NOT NULL, default 0 | Circuit-breaker |
| `was_broadcast` | boolean | NOT NULL, default false | First-broadcast latch |
| `batch` | varchar(64) NULL | indexed | Batch grouping |
| `notify_json` | longtext | NOT NULL, default `'{}'` | Notification subscribers |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

**Migration mapping**:
- TS `transactions.status` → v3 `lifecycle`.
- TS `proven_tx_reqs.{status, attempts, notified, batch, history, notify, wasBroadcast, rebroadcastAttempts, txid}` → merged into `transactions` columns (`processing`, `attempts`, `next_action_at`, `batch`, `notify_json`, `was_broadcast`, `rebroadcast_cycles`, `txid`).
- TS `proven_tx_reqs.rawTx, inputBEEF` → already present on `transactions`.
- Go `known_txs.*` → similar merger.

The legacy `proven_tx_reqs` table is retired post-migration. The legacy `transactions.status` column is dropped. **`history` JSON is split into a new audit table — see §3.5.**

**Required indexes:**
- `(userId, lifecycle, processing)` — list queries
- `(processing, next_action_at)` — monitor work-queue scans
- `(txid)` — txid lookups (separate from PK)
- `(provenTxId)` — reorg joins

### 3.2 `outputs`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `outputId` | bigint, auto-inc | PK | |
| `userId` | bigint | FK → users, NOT NULL | |
| `transactionId` | bigint | FK → transactions, NOT NULL | |
| `vout` | int | NOT NULL | |
| `basketId` | bigint NULL | FK → output_baskets | |
| `txid` | varchar(64) NULL | denormalized for index speed | |
| `satoshis` | bigint | NOT NULL | |
| `locking_script` | binary NULL | | |
| `script_length` | bigint unsigned NULL | | |
| `script_offset` | bigint unsigned NULL | | |
| `type` | varchar(50) | NOT NULL | |
| `purpose` | varchar(20) | NOT NULL | |
| `provided_by` | varchar(20) | NOT NULL | enum `you|storage|you-and-storage` |
| `change` | boolean | NOT NULL, default false | |
| `is_coinbase` | boolean | NOT NULL, default false | Denormalized from `transactions.is_coinbase` |
| `matures_at_height` | int unsigned NULL | | Only set if `is_coinbase`; equals `proven_txs.height + CoinbaseMaturity` |
| `spendable` | boolean | NOT NULL, default false, indexed | §2.2 — cached derivation |
| `spent_by` | bigint NULL | FK → transactions.transactionId, indexed | |
| `sequence_number` | int unsigned NULL | | For replace-by-fee semantics |
| `spending_description` | varchar(2048) NULL | | |
| `output_description` | varchar(2048) | NOT NULL | |
| `derivation_prefix` | varchar(200) NULL | | |
| `derivation_suffix` | varchar(200) NULL | | |
| `custom_instructions` | varchar(2500) NULL | | |
| `sender_identity_key` | varchar(130) NULL | | |
| `row_version` | bigint | NOT NULL, default 0 | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

**Uniqueness:** `(transactionId, vout, userId)` UNIQUE.

**Required indexes:**
- `(userId, spendable, basketId, satoshis)` — input selection (hot path)
- `(userId, spendable, outputId)` — pagination
- `(spent_by)`
- `(txid, vout)` — outpoint lookup
- `(matures_at_height) WHERE is_coinbase AND NOT spendable` — coinbase maturity sweep (partial index where dialect supports)

**Migration mapping:** TS `outputs.spendable` is preserved. Go's `user_utxos` table is dropped — its `UTXOStatus` enum collapses into `outputs.spendable` per the derivation in §2.2. Go's `outputs.tx_status` denormalization is dropped (use the join through `transactionId`).

### 3.3 `proven_txs`

Append-only proof record, with reorg-aware updates.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `provenTxId` | bigint, auto-inc | PK | |
| `txid` | varchar(64) | NOT NULL, UNIQUE | |
| `height` | int unsigned | NOT NULL, indexed | |
| `merkle_index` | int unsigned | NOT NULL | Leaf offset. **0 ⇒ coinbase**. |
| `merkle_path` | binary | NOT NULL | BUMP-encoded |
| `merkle_root` | varchar(64) | NOT NULL | |
| `block_hash` | varchar(64) | NOT NULL, indexed | |
| `raw_tx` | binary | NOT NULL | |
| `row_version` | bigint | NOT NULL, default 0 | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

**Required indexes:** `(block_hash)` for reorg invalidation; `(height)` for maturity sweeps; `(txid)` UNIQUE.

### 3.4 `chain_tip`

A new singleton table tracking the wallet's view of the active chain tip. Lets every query that needs `tipHeight` read it locally instead of round-tripping to chaintracks.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | int | PK, fixed = 1 | Singleton |
| `height` | int unsigned | NOT NULL | |
| `block_hash` | varchar(64) | NOT NULL | |
| `merkle_root` | varchar(64) | NOT NULL | |
| `observed_at` | datetime | NOT NULL | When wallet last observed this tip |
| `row_version` | bigint | NOT NULL, default 0 | |

Updates from the `TipTracker` task (§12) are gated by `row_version` to detect concurrent updates from sibling monitor processes.

### 3.5 `tx_audit`

Per-event audit log. Replaces TS `proven_tx_reqs.history` JSON blob and Go `tx_notes` rows.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `auditId` | bigint, auto-inc | PK | |
| `transactionId` | bigint | FK → transactions, NOT NULL, indexed | |
| `at` | datetime | NOT NULL, indexed | |
| `what` | varchar(40) | NOT NULL, indexed | Event tag — §11 |
| `actor` | varchar(40) | NOT NULL | e.g., `monitor:CheckForProofs`, `user:42`, `admin`, `system` |
| `from_lifecycle` | varchar(20) NULL | | If event changed lifecycle |
| `to_lifecycle` | varchar(20) NULL | | |
| `from_processing` | varchar(20) NULL | | If event changed processing |
| `to_processing` | varchar(20) NULL | | |
| `details_json` | longtext NULL | | Event-specific structured detail |

Required indexes: `(transactionId, at DESC)` for per-tx history reads; `(what, at DESC)` for org-wide aggregation.

**Migration:** TS `proven_tx_reqs.history` JSON entries are parsed and replayed into `tx_audit` rows. Go `tx_notes` rows mapped 1:1.

### 3.6 `monitor_lease`

Cooperative worker leasing for distributed monitor instances.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `task_name` | varchar(40) | PK | e.g., `CheckForProofs` |
| `worker_id` | varchar(64) | NOT NULL | hostname:pid:uuid |
| `acquired_at` | datetime | NOT NULL | |
| `expires_at` | datetime | NOT NULL, indexed | |
| `row_version` | bigint | NOT NULL, default 0 | |

A worker MUST acquire the lease (`UPDATE … WHERE expires_at < now() OR worker_id = ?`) before running a task. Leases auto-expire on `expires_at`. This makes horizontal scaling safe and removes the v2 single-writer constraint.

### 3.7 Tables carried unchanged

`users`, `certificates`, `certificate_fields`, `output_baskets`, `output_tags`, `output_tags_map`, `tx_labels`, `tx_labels_map`, `commissions`, `monitor_events`, `settings`, `sync_states`.

Field-level naming aligns to snake_case throughout to remove the Go-vs-TS mixed-case friction. Implementations may map to camelCase in their domain models; the on-disk names are normative.

### 3.8 Tables dropped post-migration

- `proven_tx_reqs` (TS) — merged into `transactions`.
- `known_txs` (Go) — merged into `transactions`.
- `user_utxos` (Go) — derivation collapsed into `outputs.spendable`.

---

## 4. Status enums (v3)

### 4.1 `tx.lifecycle` (application-visible)

| Value | Meaning |
|---|---|
| `draft` | Created, not yet signed. (Replaces TS `unsigned`.) |
| `queued` | Signed, awaiting processing. (Replaces TS `unprocessed`.) |
| `nosend` | Signed, intentionally not broadcast. |
| `nonfinal` | nLockTime in future. |
| `pending` | Broadcast in flight or recently accepted; awaiting confirmation. (Unifies TS `sending`/`unproven` from the user POV.) |
| `confirmed` | ≥`MinConfirmationDepth` blocks deep, proof valid. (Replaces TS `completed`.) |
| `failed` | Terminal. Either `invalid` or `doubleSpend` per `processing` state. |
| `frozen` | New: terminal-but-recoverable. Admin or reorg-coinbase loss. Outputs unspendable, no further automatic processing. |

**Why rename?** v3 separates lifecycle (what the user sees) from processing (what the monitor is doing). Reusing TS's `unproven` was conflating the two. The names above are user-facing.

### 4.2 `tx.processing` (monitor-visible)

| Value | Meaning |
|---|---|
| `unsent` | Queued for first broadcast. |
| `nosend` | Will not be broadcast by this wallet. |
| `nonfinal` | Awaiting nLockTime. |
| `sending` | Broadcast attempt in flight or pending retry. |
| `unmined` | At least one broadcaster accepted; in mempool. |
| `callback` | Awaiting broadcaster callback / SSE. |
| `unconfirmed` | Proof acquired, depth < `MinConfirmationDepth`. |
| `proven` | Depth ≥ `MinConfirmationDepth`. (Replaces TS `completed` on the req side.) |
| `invalid` | Terminal: rejected by all broadcasters. |
| `doubleSpend` | Terminal: confirmed conflict. |
| `reorging` | New: a previously `proven` tx whose block was orphaned; awaiting reprove. |
| `unfail` | Admin retry of a terminal failure. |

**`reorging` is a transient state** — replaces Go's `reorg` and TS's hidden "stuck `completed` with bad proof" behavior. Visible. Auditable. The monitor knows what to do with it.

**`invalid` string** — explicitly `invalid` (not Go's `invalidTx`). Single canonical spelling.

### 4.3 `lifecycle` ↔ `processing` coupling rules

Both columns coexist on the same row. The following pairs are the only legal combinations:

| `lifecycle` | Legal `processing` values |
|---|---|
| `draft` | `unsent` |
| `queued` | `unsent`, `nonfinal`, `nosend` |
| `nosend` | `nosend` |
| `nonfinal` | `nonfinal` |
| `pending` | `sending`, `unmined`, `callback`, `unconfirmed` |
| `confirmed` | `proven` |
| `failed` | `invalid`, `doubleSpend` |
| `frozen` | `invalid`, `doubleSpend`, `reorging` |

Implementations MUST enforce this invariant with a CHECK constraint or equivalent application-level guard.

---

## 5. Coupled FSM

### 5.1 Combined diagram

```
                       ┌──────────────────┐
                       │ (draft, unsent)  │  createAction
                       └────────┬─────────┘
                                │ sign
                                ▼
                       ┌───────────────────┐
        ┌──────────────│ (queued, unsent)  │──────────────┐
        │              └────────┬──────────┘              │
        │                       │                          │
   noSend│             nLockTime│ future               normal│ broadcast
        │                       │                          │
        ▼                       ▼                          ▼
 (nosend, nosend)    (nonfinal, nonfinal)         (pending, sending)
        │                       │                          │
        │ external broadcast    │ time reached             │ aggregate
        │ + proof acquired      │                          │
        │                       └────────► (queued,        ▼
        │                                    unsent)  ┌─────────────────┐
        │                                             │ aggregate result │
        │                                             └───┬───┬───┬───────┘
        │                                                 │   │   │
        │                                       success   │   │   │ serviceError
        │                                                 ▼   │   │
        │                                       (pending,     │   │
        │                                        unmined)─────┘   │
        │                                          │              ▼
        │                                          │       (pending, sending)
        │                                          ▼              │
        │                                       proof              loops, then
        │                                          │              circuit-break
        │                                          ▼              │
        │                                  (pending,               │
        │                                   unconfirmed)           │
        │                                          │              │
        │                                          │ depth         │
        │                                          ▼               │
        │                                   (confirmed, proven)    │
        │                                                          │
        └────────────────────► aggregate doubleSpend / invalid ─►(failed, *)
                                                                    │
                                                            admin   │
                                                                    ▼
                                                            (queued/pending,
                                                              unfail-flavored)
                                                                    │
                                                            recovers│  fails again
                                                                    ▼  │
                                                                       (failed, *)

REORG branch:
   (confirmed, proven) ──block orphaned──► (pending, reorging) ──reprove──► (pending, unconfirmed) ──► (confirmed, proven)
                                                  │
                                  reproves exhausted (coinbase only)
                                                  ▼
                                          (frozen, reorging)
```

### 5.2 Allowed transitions table

Implementations MUST allow exactly these pair-transitions and MUST reject any other. Tests enumerate each.

| From `(lifecycle, processing)` | To `(lifecycle, processing)` | Trigger |
|---|---|---|
| `(draft, unsent)` | `(queued, unsent)` | sign |
| `(draft, unsent)` | `(failed, invalid)` | abort |
| `(queued, unsent)` | `(nosend, nosend)` | noSend flag |
| `(queued, unsent)` | `(nonfinal, nonfinal)` | nLockTime future detection |
| `(queued, unsent)` | `(pending, sending)` | broadcast attempt |
| `(queued, unsent)` | `(failed, invalid)` | abandoned past age |
| `(nonfinal, nonfinal)` | `(queued, unsent)` | nLockTime reached |
| `(nosend, nosend)` | `(pending, unmined)` | external broadcast detected via `CheckNoSends` |
| `(nosend, nosend)` | `(confirmed, proven)` | external proof at depth |
| `(pending, sending)` | `(pending, unmined)` | aggregate success |
| `(pending, sending)` | `(pending, sending)` | aggregate serviceError, retry |
| `(pending, sending)` | `(failed, invalid)` | aggregate invalid |
| `(pending, sending)` | `(failed, doubleSpend)` | aggregate doubleSpend confirmed |
| `(pending, unmined)` | `(pending, callback)` | callback subscribed |
| `(pending, unmined)` | `(pending, unconfirmed)` | proof acquired, depth < min |
| `(pending, unmined)` | `(pending, unsent)` | rebroadcast cycle |
| `(pending, callback)` | `(pending, unconfirmed)` | proof acquired |
| `(pending, unconfirmed)` | `(confirmed, proven)` | depth ≥ min |
| `(pending, unconfirmed)` | `(pending, reorging)` | reorg detected |
| `(confirmed, proven)` | `(pending, reorging)` | reorg detected |
| `(pending, reorging)` | `(pending, unconfirmed)` | reprove success at new height |
| `(pending, reorging)` | `(frozen, reorging)` | reproves exhausted **AND coinbase** |
| `(failed, invalid)` | `(queued, unsent)` | unfail success |
| `(failed, invalid)` | `(failed, invalid)` | unfail retry, still failing |
| `(failed, doubleSpend)` | `(queued, unsent)` | unfail success |

Any other transition is illegal and MUST be rejected with `WERR_INVALID_TRANSITION` (TS) / `ErrInvalidTransition` (Go).

---

## 6. Output spendability — formal rules

### 6.1 Derivation

For every row in `outputs`:

```
spendable_derived =
   (transactions.lifecycle IN ('pending', 'confirmed', 'nosend'))
   AND (spent_by IS NULL)
   AND (locking_script IS NOT NULL)
   AND (NOT is_coinbase OR matures_at_height <= chain_tip.height)
```

(For `nosend`: outputs of a `nosend` tx are spendable iff the user explicitly opts in via `includeNoSend`. Default selection excludes them.)

### 6.2 Cached `outputs.spendable`

`outputs.spendable` MUST equal `spendable_derived` after any of these triggers:

- `transactions.lifecycle` change for the owning tx
- `outputs.spent_by` change for this row
- `chain_tip.height` advance crossing a coinbase maturity threshold
- Manual reconciliation task

Every such trigger updates the cached column atomically with the trigger event.

### 6.3 Forbidden behaviors

- MUST NOT consult any side index for input selection. Only `outputs.spendable` (the cached column).
- MUST NOT flip `spendable` on a reorg event (except via the indirect `lifecycle` flip for the coinbase-lost case).
- MUST NOT modify `spendable` during the `unfail` transition beyond what is implied by the resulting `(lifecycle, processing)` per §5.2.

### 6.4 Reconciliation invariant

A periodic `ReconcileSpendable` task (§12) MUST scan a sliding window of rows and verify `outputs.spendable == spendable_derived`. Disagreements MUST be logged at error severity and emit a `tx_audit.what='reconcileDrift'` event. Drift is a bug, not a fact of life.

---

## 7. Broadcast — sequential, idempotent, deterministic

### 7.1 Ordering

Sequential fallback only. Parallel broadcast is forbidden.

```
providers = [arc-primary, arc-secondary, woc, bitails]

for provider in providers:
    deadline = now() + softTimeout(provider, beef.size)
    result = call provider with idempotency_key, deadline
    record result in tx_audit
    if result.success:                return success
    if result.confirmed_doubleSpend:  return doubleSpend
    if result.timeout or service_err: continue
    if result.status_error:           record; continue

return aggregate based on §7.3
```

### 7.2 Idempotency

Every broadcast call carries `transactions.idempotency_key`. Providers honoring the key deduplicate. Providers that don't are detected by us comparing txids: if a "rejection" returns the txid we sent, we treat it as success (already-in-mempool).

### 7.3 Aggregation rules

After the loop:

- `successCount ≥ 1` ⇒ **success** (regardless of any other report). Discrepancies are recorded as `tx_audit` events but do not flip the outcome. Positive evidence wins.
- `successCount == 0 AND doubleSpendCount ≥ 1` ⇒ confirm via independent lookup (`getStatusForTxids`). Only after independent confirmation: **doubleSpend**.
- `successCount == 0 AND doubleSpendCount == 0 AND statusErrorCount ≥ 1 AND serviceErrorCount == 0` ⇒ **invalid**.
- `serviceErrorCount ≥ 1 AND successCount == 0` ⇒ **serviceError** (retry; `processing` stays `sending`, `attempts++`).

### 7.4 Soft-timeout budget

Per provider: `BroadcastSoftTimeoutMs + (beef_size_kib × BroadcastSoftTimeoutPerKbMs)`, capped at `BroadcastSoftTimeoutMaxMs`. After timeout the in-flight promise is abandoned but its eventual result, if successful, is reconciled via the `processBroadcastReceipts` task (§12).

### 7.5 Rebroadcast circuit-breaker

- `MaxProofAttempts` reached AND `was_broadcast == true` AND `rebroadcast_cycles < MaxRebroadcastAttempts` → transition `(pending, *) → (queued, unsent)`, increment `rebroadcast_cycles`.
- `MaxProofAttempts` reached AND `was_broadcast == true` AND `rebroadcast_cycles ≥ MaxRebroadcastAttempts` → `(failed, invalid)`.
- `MaxProofAttempts` reached AND `was_broadcast == false` → `(failed, invalid)` immediately. No retry; nobody ever accepted it.

---

## 8. internalizeAction

### 8.1 BEEF with proof

1. Verify scripts. Validate BUMP against chaintracks. **Fail ⇒ abort, no rows persisted.**
2. Compute `depth = chain_tip.height - bump.blockHeight`.
3. Open DB transaction.
4. Insert/upsert `transactions` row: `idempotency_key` generated; `is_coinbase = (bump.index == 0)`; `is_outgoing = false`; `txid`, `raw_tx`, `input_beef` set.
5. Insert/upsert `proven_txs` row.
6. Set transaction's `provenTxId`.
7. Determine status pair:
   - `depth >= MinConfirmationDepth` ⇒ `(confirmed, proven)`.
   - `depth < MinConfirmationDepth` ⇒ `(pending, unconfirmed)`.
8. Insert `outputs` per spec, with `is_coinbase` and `matures_at_height` if applicable.
9. Compute and write each output's `spendable` per §6.1.
10. Emit `tx_audit.what='internalizeAction'`.
11. Commit.

### 8.2 BEEF without proof

1. Verify scripts.
2. Open DB transaction.
3. Insert rows with `(queued, unsent)`, outputs not yet spendable.
4. Commit insert transaction. **Inserts and broadcast are now separated.** This is a deliberate choice in v3: the action returns immediately with a `reference`, the `SendWaiting` task drives the broadcast asynchronously. The caller polls via `listActions` or subscribes to a webhook.
5. The `SendWaiting` task will pick it up on its next tick. If broadcast aggregates to `invalid` or confirmed `doubleSpend`, the tx moves to `failed`. The caller observes via polling/webhook and decides whether to retain or `abortAction`.

**Why async?** Synchronous broadcast at internalize time blocks the action API call on slow/hung providers. v3 prefers fast action returns + observable state over blocking semantics. Users who want synchronous behavior can poll with a short backoff. v1/v2's "discard on broadcast failure" semantics are replaced by **explicit `failed` state**, which is auditable and recoverable via `abortAction` or `unfail`.

### 8.3 Idempotency on internalize

If a row with the same `txid` and `userId` already exists in non-terminal lifecycle, this is treated as a merge (basket insertions, wallet payments). Existing `failed` rows reject the merge with `WERR_INVALID_STATE`.

---

## 9. Coinbase transactions

### 9.1 Detection (canonical)

`proven_txs.merkle_index == 0 ⇒ tx is coinbase.` This is recorded on the `transactions` row (`is_coinbase`) and propagated to each output (`outputs.is_coinbase`).

### 9.2 Maturity

`outputs.matures_at_height = proven_txs.height + CoinbaseMaturity` (default 100).

Coinbase outputs have `spendable = false` until `chain_tip.height >= matures_at_height`. The cached column is updated by `CoinbaseMaturity` task on each tip advance.

### 9.3 Coinbase reorg

If a coinbase tx's block is orphaned:
1. Standard reorg flow: `(confirmed, proven) → (pending, reorging)`.
2. Outputs' `spendable` is NOT flipped at this step — output spendable continues to derive from `is_coinbase AND matures_at_height ≤ tipHeight`. Since the reproven height may differ, `matures_at_height` is recomputed when a new proof is found.
3. **If reproves exhaust without finding the coinbase on the new chain:** transition to `(frozen, reorging)`. Re-derive `outputs.spendable`: since `lifecycle ∈ ('pending', 'confirmed', 'nosend')` is now violated, outputs flip to `spendable = false`. No automatic retry beyond this point. Admin can `abortAction` or `unfail`.

### 9.4 Listing

`listOutputs` MUST filter immature coinbase outputs by default. Callers may opt in via `includeImmature: true`.

---

## 10. Reorganization handling

### 10.1 Detection

A reorg is detected by either:
- Chaintracks pushing deactivated headers (TS legacy path).
- A `TipTracker` task observing a chain tip whose height ≤ the prior recorded tip but with a different hash.

Both routes feed the same `ReorgQueue` (a logical concept, materialized as rows in `transactions` with `processing='reorging'`).

### 10.2 Action

For each orphaned block hash:

1. Find every `proven_txs` row with that `block_hash`.
2. For each, find every `transactions` row pointing at it.
3. In a single DB transaction:
   - Transition `(confirmed, proven) → (pending, reorging)`.
   - Clear `provenTxId` from `transactions`.
   - Schedule reprove (`next_action_at = now() + ReorgAgeMsecs`).
   - Emit `tx_audit.what='reorgInvalidatedProof'`.
   - Re-derive `outputs.spendable` (typically no change — `lifecycle='pending'` still satisfies the derivation).
4. Optionally delete the `proven_txs` row if no other tx references it.

### 10.3 Reprove

Reprove task picks up `(pending, reorging)` rows and asks services for a fresh merkle path:

- New path found, valid against chaintracks ⇒ insert/update `proven_txs`, transition to `(pending, unconfirmed)` (depth check will promote to `(confirmed, proven)` on next sync).
- New path not found, retries within budget ⇒ stay in `reorging`, increment `attempts`.
- Retries exhausted:
  - If `is_coinbase` ⇒ `(frozen, reorging)`. §9.3.
  - Otherwise ⇒ stay in `reorging` indefinitely with reduced cadence. **No automatic transition to `failed`.** A reorg that "lost" a non-coinbase tx is most likely a transient services issue, not a chain fact; eventually the proof will resurface.

### 10.4 Outputs and inputs

Reorg flips no output's `spendable` directly. Indirect changes only via the lifecycle derivation in §6.1.

---

## 11. Audit log (`tx_audit`)

### 11.1 Canonical event tags

| `what` | Emitted by |
|---|---|
| `createAction` | createAction |
| `signAction` | signAction |
| `abortAction` | abortAction |
| `internalizeAction` | internalizeAction |
| `broadcastAttempt` | per-provider broadcast call |
| `broadcastProviderResult` | per-provider result |
| `aggregateResult` | aggregator |
| `proofFetchAttempt` | sync task |
| `proofAcquired` | sync task |
| `proofPromotedToConfirmed` | depth-gate promotion |
| `reorgInvalidatedProof` | reorg task |
| `reproveSuccess` | reprove task |
| `reproveExhausted` | reprove task, retries done |
| `coinbaseMatured` | maturity task |
| `coinbaseLost` | reorg task → frozen |
| `unfailAttempt` | unfail task |
| `rebroadcastCycle` | circuit-breaker |
| `failedAbandoned` | reaper |
| `reconcileDrift` | reconcile task |
| `tipAdvanced` | tip tracker |

### 11.2 Required fields per event

Every row carries `(at, what, actor, transactionId)`. State-change events additionally populate `(from_lifecycle, to_lifecycle, from_processing, to_processing)`. Event-specific data goes in `details_json`.

### 11.3 Retention

Implementations MUST retain audit rows for at least 90 days. A `Reaper` task (§12) MAY archive older rows to a separate table or external storage.

---

## 12. Monitor task catalog

All implementations run the same task set. Cadences are minimums.

| Task | Cadence | Responsibility |
|---|---|---|
| `TipTracker` | poll ≤60s | Update `chain_tip` row, detect tip changes, push reorg events. |
| `SendWaiting` | poll ≤30s | Pick up `(queued, unsent)`, broadcast sequentially per §7. |
| `CheckForProofs` | trigger on tip change | For `(pending, unmined|callback|unconfirmed)` rows, fetch merkle path; promote per §5.2. |
| `CheckNoSends` | every `CheckNoSendPeriodHours` | Re-check `(nosend, nosend)` rows for external broadcast. |
| `Reorg` | event-driven + every 5 min sweep | Process `reorging` rows per §10. |
| `CoinbaseMaturity` | trigger on tip change | Re-derive coinbase output spendability per §9.2. |
| `Reaper` | hourly | Mark abandoned `(queued, unsent)`/`(draft, unsent)` rows older than `FailAbandonedAgeSeconds` as `(failed, invalid)`. |
| `UnFail` | every ≤10 min | Process `unfail` admin retries per §11. |
| `ReconcileSpendable` | every 30 min | §6.4 invariant scan. |
| `ProcessBroadcastReceipts` | every 5 min | Handle late successes from soft-timed-out broadcasts. |
| `AuditPrune` | daily | Archive audit rows past retention. |

### 12.1 Worker leasing

Each task acquires a `monitor_lease` row (§3.6) for its `task_name` before running. Workers refresh their lease on each iteration and release on graceful shutdown. Crashed workers' leases expire automatically.

### 12.2 Backpressure

Tasks process rows in pages of ≤1000. After a page, they yield. If the work queue depth exceeds a threshold, the implementation MAY scale out (spawn more workers, each acquiring its own task lease).

---

## 13. Configuration

| Constant | Default | Description |
|---|---|---|
| `MinConfirmationDepth` | 1 | Block depth for `confirmed`. |
| `CoinbaseMaturity` | 100 | Block depth for coinbase outputs. |
| `MaxProofAttempts` | 100 | Proof-fetch attempts before circuit-breaker. |
| `MaxRebroadcastAttempts` | 0 (unlimited) | Rebroadcast cycles. |
| `CheckNoSendPeriodHours` | 24 | nosend re-check cadence. |
| `FailAbandonedAgeSeconds` | 3600 | Age for abandoned-tx reaper. |
| `BroadcastSoftTimeoutMs` | 5000 | Per-provider base timeout. |
| `BroadcastSoftTimeoutPerKbMs` | 50 | Adaptive per-KiB. |
| `BroadcastSoftTimeoutMaxMs` | 30000 | Cap. |
| `ReorgAgeMsecs` | 600000 | Wait before reprove. |
| `ReorgMaxRetries` | 3 | Reprove retries. |
| `MonitorLeaseSeconds` | 60 | Worker lease TTL. |
| `AuditRetentionDays` | 90 | Minimum audit retention. |

Implementations MUST expose these via their existing config mechanism (`defs.*` in Go, `Setup` options in TS) and apply identical default values.

---

## 14. Atomicity & ordering

### 14.1 Required atomic units

Each MUST be a single DB transaction:

1. createAction body (insert tx + allocate inputs + insert change outputs + audit).
2. signAction body (status change + raw_tx + audit).
3. processBroadcastResult body (status pair update + outputs flip + audit + provenTx insert if applicable).
4. internalizeAction proof path (per §8.1).
5. internalizeAction no-proof path (per §8.2 — note: broadcast is separated, the insert is one atomic unit on its own).
6. Reorg invalidation per orphaned block (per §10.2).
7. Reprove success (per §10.3).
8. Coinbase maturity flip per output (single transaction per batch).
9. Unfail decision (per §11.1).
10. Reconciliation correction (correction + audit row in one tx).

### 14.2 Write ordering inside a transaction

1. `proven_txs` insert/update.
2. `chain_tip` read (no write needed unless this is TipTracker).
3. `transactions` lifecycle + processing + `row_version++`.
4. `outputs` spent_by + spendable flips + `row_version++`.
5. `tx_audit` insert(s).

### 14.3 Isolation

Minimum READ COMMITTED. SQLite is SERIALIZABLE by engine default. Postgres/MySQL use READ COMMITTED + `row_version` optimistic locking for cross-process safety.

---

## 15. Conformance test suite

The following tests are normative. Both implementations MUST publish them as part of their public test corpus and MUST pass them against shared fixtures.

### 15.1 FSM coverage

For each row in §5.2, a test named `T_FSM_<from>_to_<to>` that exercises the transition.

### 15.2 Schema parity

- `T_SCHEMA_01_columns_match` — both implementations report identical `(column_name, type_class, nullable)` triples for every table.
- `T_SCHEMA_02_indexes_match` — required indexes present.
- `T_SCHEMA_03_ts_writes_go_reads` — DB seeded by TS opens cleanly in Go; `listActions`/`listOutputs` return equal results.
- `T_SCHEMA_04_go_writes_ts_reads` — converse.
- `T_SCHEMA_05_no_legacy_tables` — neither `proven_tx_reqs`, `known_txs`, nor `user_utxos` exists post-migration.

### 15.3 Broadcast

- `T_BROADCAST_01_sequential` — only one provider in flight at a time.
- `T_BROADCAST_02_success_wins_over_doubleSpend` — mixed result resolves to success.
- `T_BROADCAST_03_invalid_only_after_all_fail` — single statusError + serviceError + success ⇒ success; single statusError + serviceError + nothing else ⇒ serviceError.
- `T_BROADCAST_04_idempotency_key_reused` — retries use same key.
- `T_BROADCAST_05_soft_timeout_falls_through` — hung provider does not block.

### 15.4 Coinbase

- `T_COINBASE_01_detected_at_index_zero`.
- `T_COINBASE_02_matures_at_height_set_correctly`.
- `T_COINBASE_03_not_spendable_before_maturity`.
- `T_COINBASE_04_spendable_at_exact_maturity_height`.
- `T_COINBASE_05_reorg_lost_coinbase_freezes`.
- `T_COINBASE_06_listOutputs_excludes_immature_by_default`.

### 15.5 Reorg

- `T_REORG_01_confirmed_to_reorging`.
- `T_REORG_02_reorging_to_unconfirmed_on_reprove`.
- `T_REORG_03_outputs_spendable_preserved`.
- `T_REORG_04_never_marks_invalid_non_coinbase`.
- `T_REORG_05_audit_contains_reorgInvalidatedProof_and_reproveSuccess`.

### 15.6 Output cache integrity

- `T_OUTPUT_01_failed_tx_outputs_unspendable` — cached `spendable` matches derivation.
- `T_OUTPUT_02_inputs_restored_on_failure`.
- `T_OUTPUT_03_reconcile_detects_drift` — manually corrupt a `spendable` value; reconcile task finds and corrects it, emits `reconcileDrift`.
- `T_OUTPUT_04_input_selection_never_reads_side_index`.

### 15.7 Concurrency

- `T_CONC_01_lease_grants_exclusivity` — two workers, only one runs the task.
- `T_CONC_02_lease_expires_on_crash` — kill worker, lease expires, sibling acquires.
- `T_CONC_03_row_version_detects_conflict` — concurrent updates collide; one retries.

### 15.8 Coupled FSM invariant

- `T_COUPLING_01_no_illegal_pair` — fuzz test attempts every `(lifecycle, processing)` cross-product; only legal pairs from §4.3 are accepted.

### 15.9 Audit

- `T_AUDIT_01_every_transition_logged`.
- `T_AUDIT_02_canonical_what_tags` — exactly the strings in §11.1.

### 15.10 Cross-runtime soak

- `T_SOAK_01_alternating_runtimes` — run a workload, alternating which runtime is active each minute, on a shared SQLite DB. Final state from both runtimes' views is identical.

---

## 16. Migration plan from current state

### 16.1 Shared migration script (per dialect)

The migration is delivered as a single ordered SQL migration applicable from either the current TS schema or the current Go schema. Pseudocode:

```sql
-- 1. Add new columns to transactions
ALTER TABLE transactions
  ADD COLUMN lifecycle VARCHAR(20),
  ADD COLUMN processing VARCHAR(20),
  ADD COLUMN row_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN idempotency_key VARCHAR(64),
  ADD COLUMN is_coinbase BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lifecycle_changed_at DATETIME,
  ADD COLUMN processing_changed_at DATETIME,
  ADD COLUMN next_action_at DATETIME,
  ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN rebroadcast_cycles INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN was_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN batch VARCHAR(64),
  ADD COLUMN notify_json LONGTEXT NOT NULL DEFAULT '{}';

-- 2. Backfill lifecycle from existing status
UPDATE transactions SET lifecycle = CASE status
  WHEN 'unsigned'    THEN 'draft'
  WHEN 'unprocessed' THEN 'queued'
  WHEN 'nosend'      THEN 'nosend'
  WHEN 'nonfinal'    THEN 'nonfinal'
  WHEN 'sending'     THEN 'pending'
  WHEN 'unproven'    THEN 'pending'
  WHEN 'completed'   THEN 'confirmed'
  WHEN 'failed'      THEN 'failed'
  WHEN 'unfail'      THEN 'queued'   -- retry-pending
END;

-- 3. Backfill processing from proven_tx_reqs (TS) / known_txs (Go)
-- (dialect-specific JOIN updating processing, attempts, was_broadcast, etc.)

-- 4. Migrate ProvenTxReq history JSON / tx_notes into tx_audit
-- (insert each parsed entry as a tx_audit row)

-- 5. Add new tables
CREATE TABLE chain_tip ( … );
CREATE TABLE tx_audit ( … );
CREATE TABLE monitor_lease ( … );

-- 6. Rename Go's invalidTx to invalid, reorg to reorging
UPDATE transactions SET processing = 'invalid'   WHERE processing = 'invalidTx';
UPDATE transactions SET processing = 'reorging'  WHERE processing = 'reorg';

-- 7. Drop legacy
DROP TABLE proven_tx_reqs;   -- (TS only)
DROP TABLE known_txs;        -- (Go only)
DROP TABLE user_utxos;       -- (Go only)
ALTER TABLE transactions DROP COLUMN status;

-- 8. Add new indexes
CREATE INDEX … ON transactions (userId, lifecycle, processing);
CREATE INDEX … ON transactions (processing, next_action_at);
CREATE INDEX … ON outputs (userId, spendable, basketId, satoshis);
-- … etc.

-- 9. Add is_coinbase, matures_at_height to outputs; backfill
ALTER TABLE outputs
  ADD COLUMN is_coinbase BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN matures_at_height INT UNSIGNED;

UPDATE outputs o
  SET o.is_coinbase = TRUE,
      o.matures_at_height = pt.height + 100
  FROM proven_txs pt
  JOIN transactions t ON t.provenTxId = pt.provenTxId
  WHERE pt.merkle_index = 0 AND o.transactionId = t.transactionId;

-- 10. Re-derive outputs.spendable via §6.1 across all rows
UPDATE outputs SET spendable = ( … derivation … );
```

The migration is reversible by snapshotting the source DB; the new columns are additions, the renames are pure data migrations, and the dropped tables are recreatable from `tx_audit` history.

### 16.2 Migration assertion

After migration, both implementations MUST be able to run `T_SCHEMA_05_no_legacy_tables` and the full `T_SCHEMA_*` suite without error. No row may have `(lifecycle, processing)` outside the legal set in §4.3.

### 16.3 Rollout

1. Ship v3 schema migration as a no-op for the application layer (both v2 and v3 code coexist on the new schema for one release).
2. Ship v3 application code, gated by a `wallet.spec.version='3'` setting.
3. Once both implementations have run v3 in production for a release cycle, drop v2 compatibility shims.

---

## 17. Out of scope

- Multi-tenant sharding (deferred to v4).
- Native CTV/CSV semantics beyond `lockTime`/`sequence_number`.
- Wallet-to-wallet sync protocol changes (BRC concern, not this spec).
- Hardware-wallet signing protocols.
- Per-output replace-by-fee logic beyond what `sequence_number` already supports.

---

## 18. Glossary

| Term | Definition |
|---|---|
| **Action** | BRC-100 transaction intent. |
| **BEEF** | BSV Extended Element Format (BRC-62). |
| **BUMP** | BSV Unified Merkle Path (BRC-74). |
| **chain_tip** | Wallet's view of the active chain head, stored in §3.4. |
| **coinbase** | First tx in a block; merkle leaf offset 0; awards block subsidy + fees. |
| **lifecycle** | User-visible status (§4.1). |
| **processing** | Monitor-visible status (§4.2). |
| **idempotency_key** | Per-tx token reused across broadcast retries. |
| **monitor_lease** | Cooperative worker-exclusivity row. |
| **reorging** | Transient processing state after orphan detection, awaiting reprove. |
| **row_version** | Optimistic-locking counter (§2.4). |
| **frozen** | Terminal-but-recoverable lifecycle for admin/coinbase-loss cases. |

---

**End of PROD_REQ_V3.md.**
