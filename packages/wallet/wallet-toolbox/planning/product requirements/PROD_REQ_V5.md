# PROD_REQ_V5.md — BSV Wallet UTXO & Transaction Lifecycle Specification

**Version:** 5.0
**Date:** 2026-05-11
**Status:** Draft. Supersedes v4.

---

## 0. What changed in v5

v4 kept `transactions` as a per-user table because that was the legacy shape in both TS and Go. v5 takes the question seriously: **why?**

The answer is that nothing about a transaction's network identity is per-user. A txid IS the transaction. Two users observing the same txid see the same processing state, the same proof, the same depth, the same outputs (some of which may be theirs, some not). The fields that ARE per-user — description, labels, soft-delete flag, notification subscribers, the user's idea of "nosend" intent — are *metadata about the user's view of a network transaction*, not the transaction itself.

So v5 splits cleanly:

| Concern | Table | Cardinality |
|---|---|---|
| Network transaction (one row per txid) | `transactions` | one per txid |
| User's view of a transaction (BRC-100 "Action") | `actions` | one per (user, txid) |
| User's outputs | `outputs` | one per (user, txid, vout) |

`transactions` becomes the **single source of truth** for everything about a tx's network state: processing FSM, proof data, raw bytes, attempts. There is no per-user copy of any of this. Multi-user wallets get correct deduplication for free.

The two-FSM coupling problem from v3/v4 disappears: there is now **one FSM**, on `transactions.processing`. The user-visible state shown by `listActions` is a deterministic derivation of `(transactions.processing, actions.user_nosend, actions.hidden)` computed at read time.

Everything else from v4 (sequential broadcast, granular `sent/seen/seen_multi` states, coinbase maturity, reorg as transient state, output spendability derivation, audit log, monitor leasing, idempotency keys, optimistic concurrency, conformance suite) is preserved with adjustments for the new shape.

---

## 1. Architectural overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Application (BRC-100 wallet API)                                  │
│  createAction · signAction · internalizeAction · listActions ·     │
│  listOutputs · abortAction · relinquishOutput                       │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────┴────────────────────────────────────────────────────────┐
│  Storage                                                            │
│  ─ transactions     (per-txid: processing, proof, raw_tx)            │
│  ─ actions          (per-(user, txid): user's view)                  │
│  ─ outputs          (per-user UTXO state)                            │
│  ─ chain_tip        (singleton)                                      │
│  ─ tx_audit         (per-event log)                                  │
│  ─ monitor_lease    (worker exclusion)                               │
│  ─ users, baskets, labels, tags, certs, commissions, …               │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────┴────────────────────────────────────────────────────────┐
│  Monitor tasks (run under lease)                                    │
│  TipTracker · SendWaiting · CheckForProofs · ArcSSE · CheckNoSends ·│
│  Reorg · CoinbaseMaturity · Reaper · UnFail · Reconcile ·            │
│  ProcessBroadcastReceipts · AuditPrune                              │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────┴────────────────────────────────────────────────────────┐
│  Services (ARC, Arcade SSE, WhatsOnChain, Bitails, chaintracks,     │
│            BlockHeaderService)                                       │
└────────────────────────────────────────────────────────────────────┘
```

### 1.1 Vocabulary alignment

The BRC-100 wallet API uses "Action" for what the user creates and observes. The network entity is the "Transaction" (txid). v5 makes this distinction structural:

- **Transaction**: a tx on (or potentially on) the BSV network. Identified by txid. One row in `transactions`.
- **Action**: a user's view of a transaction — what they called it, when they created/internalized it, whether they've hidden it from their UI. One row in `actions` per (user, transaction).

This matches the existing API surface: `createAction` creates an Action (and may insert a Transaction if new); `listActions` lists this user's Actions; `signAction` signs the underlying Transaction.

### 1.2 Cardinality

| Entity | Scale | Hot read | Hot write |
|---|---|---|---|
| `transactions` | 10⁶ – 10⁸ per server | by txid, by (processing, next_action_at) | append + processing update |
| `actions` | 10⁶ – 10⁹ per server | by (userId, ...) | append + lifecycle metadata |
| `outputs` | 10⁶ – 10⁹ per server | by (userId, spendable, basketId, satoshis) | append + flip |
| `tx_audit` | 10⁷ – 10¹⁰ | by (transactionId, at), (actionId, at) | append-only |

---

## 2. Domain model

### 2.1 One transaction, one FSM, many actions

The state of a network transaction is **fully described by `transactions.processing`** plus its proof fields. Any user-visible status is a deterministic function of this state plus the user's per-action flags. There is no "per-user processing state" — the network doesn't have one.

```
transactions (per-txid)
    │
    │ 1
    │
    │ N
    │
actions (per-user view)
    │
    │ 1
    │
    │ N
    │
outputs (per-user)
```

A `transactions` row exists for every txid the wallet has ever observed. An `actions` row exists for every (user, transaction) pair the user has created or internalized. An `outputs` row exists for every (user, transaction, vout) the user owns.

### 2.2 Why this works

- **One broadcast per txid.** Whoever runs `SendWaiting` against the `transactions` table sees one row per txid. No N-way coordination.
- **One proof per txid.** The proof is stored once. All users sharing the txid see it via FK.
- **One reorg per txid.** Invalidating a proof updates one `transactions` row. Per-user lifecycle is recomputed at read time.
- **Per-user customization preserved.** Descriptions, labels, references, notification subscribers, soft-deletes all live on `actions`, scoped per user.

### 2.3 Derived lifecycle for `listActions`

When `listActions` returns an Action to the user, the implementation computes a user-facing `lifecycle` string from the underlying transaction's state and the action's flags:

```
def derive_lifecycle(tx, action):
    if action.hidden:                        return 'hidden'
    if action.user_aborted:                  return 'aborted'

    match tx.processing:
        'queued' if not tx.was_broadcast:
            return 'nosend' if action.user_nosend else 'queued'
        'queued' (after broadcast):           return 'pending'    # service-error retry
        'nosend':                              return 'nosend'
        'nonfinal':                            return 'nonfinal'
        'sending', 'sent', 'seen',
        'seen_multi', 'unconfirmed':           return 'pending'
        'proven':                              return 'confirmed'
        'reorging':                            return 'pending'
        'frozen':                              return 'frozen'
        'invalid', 'doubleSpend':              return 'failed'
        'unfail':                              return 'pending'   # admin retry
```

The lifecycle is **not stored** anywhere. It is computed deterministically and reproducibly. This guarantees both implementations and any DB inspection produce the same answer.

### 2.4 Output spendability — derivation

```
spendable_derived =
    transactions.processing IN ('sent', 'seen', 'seen_multi', 'unconfirmed', 'proven')
    AND outputs.spent_by IS NULL
    AND outputs.locking_script IS NOT NULL
    AND (NOT outputs.is_coinbase OR outputs.matures_at_height <= chain_tip.height)
```

For `nosend` outputs (i.e., outputs whose owning transaction has `processing='nosend'`), the action layer may opt to include them via `includeNoSend: true` on `listOutputs`. They are NOT included by default. This is a per-call selection decision, not a per-user one.

`outputs.spendable` caches `spendable_derived`. The cache is refreshed atomically by every trigger that changes any input variable (lifecycle propagation from `transactions.processing` change, `spent_by` flip, coinbase maturity tick).

### 2.5 Idempotency, optimistic concurrency

Per-txid `idempotency_key` on `transactions`. Reused across all broadcast retries for that txid. `row_version` on all mutable tables for optimistic locking.

---

## 3. Schema (v5)

### 3.1 `transactions` (per-txid, network state)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `transactionId` | bigint, auto-inc | PK | |
| `txid` | varchar(64) NULL | UNIQUE WHEN NOT NULL, indexed | NULL until first sign |
| `processing` | varchar(20) | NOT NULL, indexed | §4 |
| `processing_changed_at` | datetime | NOT NULL | |
| `next_action_at` | datetime NULL | indexed | Monitor work-queue |
| `attempts` | int unsigned | NOT NULL, default 0 | Proof-fetch attempts |
| `rebroadcast_cycles` | int unsigned | NOT NULL, default 0 | Circuit-breaker |
| `was_broadcast` | boolean | NOT NULL, default false | First-acceptance latch |
| `idempotency_key` | varchar(64) | NOT NULL, UNIQUE | Generated at insert |
| `batch` | varchar(64) NULL | indexed | Batch grouping |
| `version` | int unsigned NULL | | tx.version |
| `lock_time` | int unsigned NULL | | tx.lockTime |
| `raw_tx` | binary NULL | | NULL while `processing='draft'` |
| `input_beef` | binary NULL | | Discardable post-proof |
| `height` | int unsigned NULL | indexed | Set when proof acquired |
| `merkle_index` | int unsigned NULL | | 0 ⇒ coinbase |
| `merkle_path` | binary NULL | | BUMP-encoded |
| `merkle_root` | varchar(64) NULL | | |
| `block_hash` | varchar(64) NULL | indexed | For reorg invalidation |
| `is_coinbase` | boolean | NOT NULL, default false | Set when merkle_index becomes 0 |
| `last_provider` | varchar(40) NULL | | Most-recent broadcaster touched |
| `last_provider_status` | varchar(40) NULL | | Raw provider state string |
| `frozen_reason` | varchar(40) NULL | | Set when `processing='frozen'` (e.g., `coinbaseLost`, `adminFreeze`) |
| `row_version` | bigint | NOT NULL, default 0 | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

**Constraints:**
- `txid` UNIQUE when not null.
- CHECK: `processing IN (legal_set)` (§4).
- CHECK: `(merkle_path IS NULL AND height IS NULL AND block_hash IS NULL) OR (merkle_path IS NOT NULL AND height IS NOT NULL AND block_hash IS NOT NULL)` — proof fields move as a unit.

**Required indexes:**
- `(txid)` UNIQUE
- `(processing, next_action_at)` — monitor work-queue scan
- `(block_hash)` — reorg invalidation
- `(height) WHERE height IS NOT NULL` — maturity / proof sweeps
- `(batch)` — batch broadcast
- `(idempotency_key)` UNIQUE

### 3.2 `actions` (per-user view)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `actionId` | bigint, auto-inc | PK | |
| `userId` | bigint | FK → users, NOT NULL | |
| `transactionId` | bigint | FK → transactions, NOT NULL | |
| `reference` | varchar(64) | NOT NULL, UNIQUE | Random base64 |
| `description` | varchar(2048) | NOT NULL | User's note |
| `is_outgoing` | boolean | NOT NULL | True if this user signed it |
| `satoshis_delta` | bigint | NOT NULL, default 0 | Net delta for THIS user |
| `user_nosend` | boolean | NOT NULL, default false | This user does not want their wallet broadcasting |
| `hidden` | boolean | NOT NULL, default false | Soft-delete from user's view |
| `user_aborted` | boolean | NOT NULL, default false | User called abortAction |
| `notify_json` | longtext | NOT NULL, default `'{}'` | Per-user notification subscribers |
| `row_version` | bigint | NOT NULL, default 0 | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

**Constraints:**
- UNIQUE `(userId, transactionId)` — each user has at most one Action per transaction.
- UNIQUE `(reference)`.

**Required indexes:**
- `(userId, hidden, transactionId)` — listActions
- `(transactionId)` — cascade joins
- `(reference)` UNIQUE

### 3.3 `outputs` (per-user)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `outputId` | bigint, auto-inc | PK | |
| `userId` | bigint | FK → users, NOT NULL | |
| `transactionId` | bigint | FK → transactions, NOT NULL | |
| `vout` | int | NOT NULL | |
| `basketId` | bigint NULL | FK → output_baskets | |
| `txid` | varchar(64) NULL | denormalized from owning tx | |
| `satoshis` | bigint | NOT NULL | |
| `locking_script` | binary NULL | | |
| `script_length` | bigint unsigned NULL | | |
| `script_offset` | bigint unsigned NULL | | |
| `type` | varchar(50) | NOT NULL | |
| `purpose` | varchar(20) | NOT NULL | |
| `provided_by` | varchar(20) | NOT NULL | |
| `change` | boolean | NOT NULL, default false | |
| `is_coinbase` | boolean | NOT NULL, default false | Denormalized from `transactions.is_coinbase` |
| `matures_at_height` | int unsigned NULL | | Set if coinbase: `transactions.height + CoinbaseMaturity` |
| `spendable` | boolean | NOT NULL, default false, indexed | Cached derivation |
| `spent_by` | bigint NULL | FK → transactions.transactionId, indexed | Per-txid, not per-action |
| `sequence_number` | int unsigned NULL | | |
| `spending_description` | varchar(2048) NULL | | |
| `output_description` | varchar(2048) | NOT NULL | |
| `derivation_prefix` | varchar(200) NULL | | |
| `derivation_suffix` | varchar(200) NULL | | |
| `custom_instructions` | varchar(2500) NULL | | |
| `sender_identity_key` | varchar(130) NULL | | |
| `row_version` | bigint | NOT NULL, default 0 | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

UNIQUE: `(transactionId, vout, userId)`.

Note: `spent_by` is `transactionId`, not `actionId`. The fact that an output was consumed is a network reality (which tx spent it), not a per-user fact. Multiple users may each see "their output was spent by tx X" — they reference the same X.

**Required indexes:**
- `(userId, spendable, basketId, satoshis)` — input selection
- `(userId, spendable, outputId)` — pagination
- `(spent_by)`
- `(txid, vout)`
- `(matures_at_height) WHERE is_coinbase AND NOT spendable`

### 3.4 `chain_tip`

| Column | Type | Notes |
|---|---|---|
| `id` | int | PK = 1 (singleton) |
| `height` | int unsigned | NOT NULL |
| `block_hash` | varchar(64) | NOT NULL |
| `merkle_root` | varchar(64) | NOT NULL |
| `observed_at` | datetime | NOT NULL |
| `row_version` | bigint | NOT NULL, default 0 |

### 3.5 `tx_audit`

| Column | Type | Notes |
|---|---|---|
| `auditId` | bigint, auto-inc PK | |
| `transactionId` | bigint NULL, indexed | per-txid events |
| `actionId` | bigint NULL, indexed | per-user-view events |
| `at` | datetime, NOT NULL, indexed | |
| `what` | varchar(40), NOT NULL, indexed | §11 |
| `actor` | varchar(40), NOT NULL | |
| `from_processing` | varchar(20) NULL | |
| `to_processing` | varchar(20) NULL | |
| `details_json` | longtext NULL | |

Note: there is no `from_lifecycle` / `to_lifecycle` column — lifecycle is derived. Audit on processing only.

Required indexes: `(transactionId, at DESC)`, `(actionId, at DESC)`, `(what, at DESC)`.

### 3.6 `monitor_lease`

| Column | Type | Notes |
|---|---|---|
| `task_name` | varchar(40) PK | |
| `worker_id` | varchar(64) NOT NULL | |
| `acquired_at` | datetime NOT NULL | |
| `expires_at` | datetime NOT NULL, indexed | |
| `row_version` | bigint NOT NULL, default 0 | |

### 3.7 `tx_labels_map` — adjusted

Previously mapped `txLabelId ↔ transactionId`. In v5, labels are per-user, so map: `txLabelId ↔ actionId`.

| Column | Type | Notes |
|---|---|---|
| `txLabelId` | bigint, FK → tx_labels | |
| `actionId` | bigint, FK → actions | |
| `isDeleted` | boolean default false | |
| `created_at`, `updated_at` | datetime | |

UNIQUE `(txLabelId, actionId)`. Indexed `(actionId)`.

### 3.8 Unchanged tables

`users`, `certificates`, `certificate_fields`, `output_baskets`, `output_tags`, `output_tags_map`, `tx_labels`, `commissions`, `monitor_events`, `settings`, `sync_states`.

### 3.9 Dropped tables / columns

- `proven_tx_reqs` (TS) — merged into `transactions`.
- `proven_txs` (TS) — merged into `transactions` (the proof fields are now on the main row).
- `known_txs` (Go) — merged into `transactions`.
- `user_utxos` (Go) — replaced by `outputs.spendable` derivation.
- Old per-user `transactions.status` enum and per-user `transactions.txid`, `raw_tx`, `input_beef` — these become per-txid columns on the new `transactions` table.

---

## 4. `transactions.processing` enum (single FSM)

```
                              ┌────────┐
                              │ draft  │  (createAction; raw_tx NULL)
                              └───┬────┘
                                  │ sign
                                  ▼
                            ┌──────────┐
            ┌───────────────│  queued  │ ◄──────── serviceError retry destination
            │               └────┬─────┘
            │                    │ SendWaiting picks up
            │                    │ (skip if any linked action has user_nosend=true and
            │                    │  no action has user_nosend=false)
            │                    ▼
            │               ┌──────────┐
            │               │ sending  │
            │               └────┬─────┘
            │                    │
            │     ┌──────────────┼──────────────┬───────────────┐
            │     │              │              │               │
       noSend│   accept         seen          error            confirmed double
            │ (HTTP 2xx)     (some providers)  (service)        spend with
            ▼     │              │              │              verification
        ┌─────────┴┐         ┌───┴───┐      ┌───┴────┐      ┌──────────────┐
        │  nosend  │         │  sent │      │ queued │      │ doubleSpend  │ (terminal)
        └──┬───────┘         └───┬───┘      └────────┘      └──────────────┘
           │                     │
           │ external broadcast  │  (Arc / Arcade)
           │ detected            │
           │                     ▼
           │                ┌──────────┐         all providers rejected with
           │                │   seen   │         statusError ──► invalid (terminal)
           │                └────┬─────┘
           │                     │  (Arcade only)
           │                     ▼
           │                ┌────────────┐
           │                │ seen_multi │
           │                └────┬───────┘
           │                     │ proof acquired
           │                     ▼
           │                ┌──────────────┐
           │                │ unconfirmed  │
           │                └────┬─────────┘
           │                     │ depth ≥ MinConfirmationDepth
           │                     ▼
           │                ┌─────────┐
           └───────────────►│ proven  │ (happy-path terminal)
                            └─────────┘

REORG branch:
   proven ──block orphaned──► reorging ──reprove──► unconfirmed ──► proven
                                  │
                       coinbase, retries exhausted
                                  ▼
                              frozen (terminal-but-recoverable)
                              frozen_reason = 'coinbaseLost'

ADMIN branch:
   invalid | doubleSpend ──admin──► unfail ──► queued (try again) or invalid (still bad)
   any ──admin freeze──► frozen (frozen_reason = 'adminFreeze')

NONFINAL:
   queued ──nLockTime > now──► nonfinal ──nLockTime reached──► queued
```

### 4.1 Complete state list

| Value | Description |
|---|---|
| `draft` | Created; not yet signed. `raw_tx IS NULL`. |
| `queued` | Signed; awaiting broadcast attempt (initial OR post-serviceError retry). |
| `nosend` | Will not be broadcast by this wallet (intent). Outputs not spendable by default. |
| `nonfinal` | Awaiting nLockTime maturity. |
| `sending` | Broadcast HTTP request in flight. |
| `sent` | Broadcaster has accepted the tx (HTTP 2xx, non-rejection). In their pipeline. |
| `seen` | `SEEN_ON_NETWORK` — other miners observe it. |
| `seen_multi` | `SEEN_MULTIPLE_NODES` — Arcade-only propagation confirmation. |
| `unconfirmed` | Proof acquired; depth < `MinConfirmationDepth`. |
| `proven` | Depth ≥ `MinConfirmationDepth`. Happy-path terminal. |
| `reorging` | Transient: proof invalidated by reorg; awaiting reprove. |
| `frozen` | Terminal-but-recoverable. `frozen_reason` distinguishes cases. Admin can re-arm via `unfail`. |
| `invalid` | Terminal: rejected by all broadcasters. |
| `doubleSpend` | Terminal: confirmed conflict. |
| `unfail` | Admin transient: retry of a terminal failure. |

### 4.2 Forward-only progression within the broadcast arc

`sending → sent → seen → seen_multi → unconfirmed → proven` is strictly forward. A provider report that maps to a state earlier in the arc than current MUST be ignored (idempotent advance) and a `tx_audit` row emitted noting the regression attempt.

Forking to terminals (`invalid`, `doubleSpend`) and reorg flow (`reorging`) are explicit, not regressions of the arc.

### 4.3 Service support matrix

| Provider | Emits | Mapping (raw → `processing`) |
|---|---|---|
| Arcade (ARC over SSE) | full pipeline | `RECEIVED/STORED/SENT_TO_NETWORK/ACCEPTED_BY_NETWORK → sent`; `SEEN_ON_NETWORK → seen`; `SEEN_MULTIPLE_NODES → seen_multi`; `MINED → unconfirmed`; `CONFIRMED → proven`; `REJECTED → invalid \| doubleSpend` |
| ARC (polled) | up to `seen` | Same as Arcade minus `seen_multi` |
| WhatsOnChain | `sent` only | Acceptance ⇒ `sent`. Subsequent advance is via our own proof fetcher. |
| Bitails | `sent` only | Same as WhatsOnChain. |

Mapping function is a single deterministic table, identical in both implementations, fully covered by tests.

---

## 5. Action layer

### 5.1 createAction

1. Generate `idempotency_key`.
2. Begin DB transaction.
3. INSERT `transactions` row with `processing='draft'`, `raw_tx=NULL`, `was_broadcast=false`.
4. INSERT `actions` row with `(userId, transactionId, reference, description, is_outgoing=true, ...)`. Generate `reference`.
5. Allocate inputs: for each consumed output, set `spent_by=transactionId`, `spendable=false` (cache flip).
6. INSERT change outputs (per user, with `transactionId` from step 3). Outputs are `spendable=false` until processing reaches `sent` or beyond.
7. Audit: `createAction` (one row, references both `transactionId` and `actionId`).
8. Commit.

### 5.2 signAction

1. Begin DB transaction.
2. UPDATE `transactions` SET `raw_tx = ?`, `txid = ?`, `processing = 'queued'`, `processing_changed_at = now()`, `row_version = row_version + 1` WHERE `transactionId = ?` AND `row_version = ?`.
3. Audit: `signAction`.
4. Commit.

The `actions` row is not touched on signing.

### 5.3 internalizeAction

#### 5.3.1 BEEF with proof

1. Validate BUMP against chaintracks. Failure ⇒ abort, no persistence.
2. Compute `depth = chain_tip.height - bump.blockHeight`.
3. Begin DB transaction.
4. UPSERT `transactions` row keyed by `txid`:
   - If new: `processing` set per depth (`proven` if depth ≥ min, else `unconfirmed`); proof fields populated; `is_coinbase = (merkle_index == 0)`; `was_broadcast = true`.
   - If existing: validate proof matches; advance `processing` if not already at or past the equivalent state.
5. UPSERT `actions` row for `(userId, transactionId)`. If new, create with `is_outgoing=false`. If existing (idempotent re-internalize), merge new outputs/labels.
6. INSERT or UPSERT `outputs` per spec; compute `is_coinbase`, `matures_at_height`, `spendable` per derivation.
7. Audit: `internalizeAction`.
8. Commit.

#### 5.3.2 BEEF without proof

1. Validate scripts.
2. Begin DB transaction.
3. UPSERT `transactions` row keyed by `txid`. If new: `processing='queued'`, `was_broadcast=false`, `raw_tx` populated, `input_beef` populated.
4. UPSERT `actions` row.
5. INSERT `outputs` (not yet spendable — derivation requires `processing >= sent`).
6. Audit: `internalizeAction`.
7. Commit. **Broadcast happens asynchronously** via `SendWaiting`.

#### 5.3.3 Multi-user dedupe

If `txid` already exists in `transactions` (a different user already internalized or created it), this user simply adds an `actions` row and `outputs` rows. No duplication of network state.

### 5.4 abortAction

1. UPDATE `actions` SET `user_aborted = true`. No change to underlying `transactions` row (if any other user shares it).
2. Cache flip on this user's outputs: `spendable = false` for outputs of this transaction owned by this user (since this user's view is now "failed"-ish).
3. If NO other action references this transaction (no other user has it), the `Reaper` task may eventually GC the transaction row.
4. Audit: `abortAction` (actionId-scoped).

Abort is per-user. It does not propagate to other users sharing the txid.

### 5.5 listActions

1. SELECT actions WHERE userId = ? AND NOT hidden (unless `includeHidden`).
2. JOIN transactions for processing + proof.
3. Compute derived `lifecycle` per §2.3.
4. JOIN tx_labels_map / tx_labels for labels (per action).
5. Return.

### 5.6 listOutputs

1. SELECT outputs WHERE userId = ? AND spendable = true (unless `includeSpent`).
2. Filter immature coinbase by default (unless `includeImmature`).
3. Filter `nosend`-tx outputs unless `includeNoSend`.
4. Return.

---

## 6. Output spendability rules

### 6.1 Derivation (canonical)

See §2.4. Restated:

```
spendable_derived(output, tx, tip) =
    tx.processing IN ('sent', 'seen', 'seen_multi', 'unconfirmed', 'proven')
    AND output.spent_by IS NULL
    AND output.locking_script IS NOT NULL
    AND (NOT output.is_coinbase OR output.matures_at_height <= tip.height)
```

Note: `tx.processing='nosend'` is NOT in the spendable set. The `listOutputs` API may add it back via `includeNoSend` flag, which short-circuits this derivation at read time only — the cached `spendable` column remains false.

### 6.2 Cache refresh triggers

The cached `outputs.spendable` MUST be refreshed atomically with any of:

- `transactions.processing` change.
- `outputs.spent_by` change.
- `chain_tip.height` advance crossing an `outputs.matures_at_height`.
- Reconcile correction.

For a `transactions.processing` change affecting M outputs across N users, the cascade is a single SQL UPDATE: `UPDATE outputs SET spendable = ?, row_version = row_version + 1 WHERE transactionId = ?`. Indexed by `transactionId`.

### 6.3 Per-user abort cache override

When a user calls `abortAction`, the outputs of that transaction owned by THIS user have `spendable` forced to `false` (overriding the derivation). This is recorded by a special per-user override mechanism:

**Option A (chosen)**: store `actions.user_aborted` and have the spendability derivation **read at query time** consult `JOIN actions ON outputs.transactionId = actions.transactionId AND actions.userId = outputs.userId WHERE NOT actions.user_aborted`. This means input selection becomes a JOIN. To preserve single-index seeks, the `outputs.spendable` cache is updated to false on abort by a synchronous cascade that scans `outputs WHERE userId = ? AND transactionId = ?` and flips them. This is fast: M ≤ vout count of the tx.

So the cache stays authoritative. Abort flips the cache for the affected user's outputs. Other users' outputs of the same tx are untouched.

### 6.4 Forbidden behaviors

- MUST NOT consult any side index for input selection.
- MUST NOT couple input-selection queries to `transactions.processing` directly — that would force a join on every selection. Read the cached `outputs.spendable`.
- MUST NOT modify `spendable` during `unfail` beyond what the standard derivation implies.

### 6.5 Reconciliation

The `Reconcile` task scans a sliding window and verifies `outputs.spendable == spendable_derived(joined to transactions, chain_tip, actions)`. Drift logs `tx_audit.what='reconcileDrift'` and corrects.

---

## 7. Broadcast pipeline

### 7.1 Selection criteria for `SendWaiting`

```sql
SELECT t.* FROM transactions t
WHERE t.processing = 'queued'
  AND (t.next_action_at IS NULL OR t.next_action_at <= now())
  AND EXISTS (
    SELECT 1 FROM actions a
    WHERE a.transactionId = t.transactionId
      AND NOT a.user_nosend
      AND NOT a.user_aborted
  )
ORDER BY COALESCE(t.next_action_at, t.created_at)
LIMIT page;
```

If every action linked to this transaction has `user_nosend = true` OR `user_aborted = true`, the row is NOT selected. The transaction stays in `queued` indefinitely. (If later a user clears `user_nosend` or a new action is added, the row becomes eligible.)

### 7.2 Broadcast loop

```
For each selected transaction:
    Acquire row lock (UPDATE ... SET processing = 'sending' WHERE row_version = ?)
    Audit: broadcastAttempt

    For provider in priority order:
        deadline = now + softTimeout(beef.size)
        result = call provider(idempotency_key, raw_tx, beef)
        Audit: broadcastProviderResult(provider, result.raw_status)

        case result:
            accepted (mapped to 'sent'): break (success)
            SEEN_ON_NETWORK (some providers report directly): processing='seen'; break
            statusError (genuine reject): continue to next provider
            serviceError or timeout: continue
            confirmedDoubleSpend (with independent verification): processing='doubleSpend'; break

    If loop exited successfully:
        UPDATE transactions SET processing = 'sent' (or 'seen'/'doubleSpend' as set), was_broadcast = TRUE, ...
        Cascade outputs.spendable = TRUE for outputs of this tx (across all users; subject to coinbase rules)

    Else if all providers returned statusError, none serviceError, none success:
        UPDATE transactions SET processing = 'invalid'
        Cascade outputs.spendable = FALSE
        Restore inputs (set their spendable = TRUE, spent_by = NULL)

    Else (some serviceError, no success):
        UPDATE transactions SET processing = 'queued', next_action_at = now + backoff
        attempts++ (or rebroadcast_cycles++ if was_broadcast=true and circuit-breaker)

    Audit: aggregateResult
```

### 7.3 Subsequent advancement

After `sent`, the row advances via:

- `CheckForProofs` polling ARC/WoC/Bitails: maps response → `sent → seen` / `sent → unconfirmed` / `sent → proven`.
- `ArcSSE` listener: Arcade events pushed → `sent → seen → seen_multi → unconfirmed → proven`.
- `next_action_at` schedules the next poll.

### 7.4 Circuit breaker

After `MaxProofAttempts` poll failures:

- If `was_broadcast = true` AND `rebroadcast_cycles < MaxRebroadcastAttempts`:
  - `processing = 'queued'`, `attempts = 0`, `rebroadcast_cycles += 1`.
- Else if `was_broadcast = true`: `processing = 'invalid'`.
- Else if `was_broadcast = false`: `processing = 'invalid'` immediately. (Nobody accepted it; no rebroadcast.)

### 7.5 Late receipts

`ProcessBroadcastReceipts` task polls `idempotency_key` against providers to catch responses that arrived after a soft-timeout. Reconciles `processing` forward if a tx we marked `invalid` is actually in mempool.

---

## 8. Coinbase

### 8.1 Detection

`transactions.merkle_index == 0 AND merkle_path IS NOT NULL ⇒ is_coinbase = true`. Set on `transactions.is_coinbase`. Cascaded to `outputs.is_coinbase`.

### 8.2 Maturity

`outputs.matures_at_height = transactions.height + CoinbaseMaturity` (default 100). Coinbase outputs `spendable = false` until `chain_tip.height >= matures_at_height`. `CoinbaseMaturity` task flips on tip advance.

### 8.3 Coinbase reorg

1. Standard reorg: `proven → reorging`, lifecycle derivation makes affected actions show `pending`.
2. Outputs' `spendable` flips to `false` because the derivation's `processing IN ('sent', 'seen', 'seen_multi', 'unconfirmed', 'proven')` is no longer satisfied — `reorging` is NOT in the spendable set. (This is a v5 refinement.)
3. Reprove attempts up to `ReorgMaxRetries`.
4. Success: re-acquire proof; `processing → unconfirmed → proven`; spendable flips back.
5. Exhausted: `processing = 'frozen'`, `frozen_reason = 'coinbaseLost'`. Outputs stay unspendable. Audit: `coinbaseLost`.

### 8.4 Listing

`listOutputs` filters immature coinbase by default. Opt-in via `includeImmature: true`.

---

## 9. Reorg handling

### 9.1 Detection

`TipTracker` observes a tip change. If the new tip's hash differs from the previously recorded at the same height, or if deactivated headers are reported, a reorg is detected.

### 9.2 Action

For each orphaned block hash:

1. SELECT `transactions WHERE block_hash IN (orphanedHashes) AND processing IN ('unconfirmed', 'proven')`.
2. For each affected row, in one DB transaction:
   - `processing = 'reorging'`; clear proof fields (`height`, `block_hash`, `merkle_root`, `merkle_index`, `merkle_path`); set `attempts = 0`; `next_action_at = now() + ReorgAgeMsecs`.
   - Cascade `outputs.spendable` for outputs of this tx (across all users): re-derive, which usually flips them to false since `reorging` is not in the spendable set.
   - Audit: `reorgInvalidatedProof` (one per affected transaction).
3. Schedule reprove via `Reorg` task.

### 9.3 Reprove

`Reorg` task scans `processing='reorging' AND next_action_at <= now()`:

- New path found: `processing = 'unconfirmed'`, set proof fields, audit `reproveSuccess`.
- Not found, attempts < `ReorgMaxRetries`: `attempts++`, reschedule with exponential backoff.
- Exhausted:
  - Coinbase: `processing = 'frozen'`, `frozen_reason = 'coinbaseLost'`. Audit: `coinbaseLost`.
  - Non-coinbase: `attempts` stays at the cap; stays in `reorging` at reduced cadence. Audit: `reproveExhausted`.

### 9.4 Reorg never marks invalid/doubleSpend

A reorg is a chain event, not a broadcaster verdict. The reorg path never transitions to `invalid` or `doubleSpend`. Only `frozen` (coinbase exhausted) or recovery via `unconfirmed → proven`.

### 9.5 Output spendability through reorg

Yes, outputs DO flip to `spendable=false` during `reorging` in v5. This is a deliberate change from v3/v4 which preserved spendability through reorg. The justification: a tx whose proof has been invalidated may not exist on the new chain. Spending an output of such a tx creates a child tx that the network will reject. Better to UN-mark it temporarily and re-mark when reproven. Risk of accidentally double-spending an output of a transient `reorging` tx is much higher than the inconvenience of momentarily-unspendable change.

---

## 10. Atomicity & ordering

### 10.1 Required atomic units

Each is one DB transaction:

1. createAction: insert transaction + insert action + allocate inputs + insert change outputs + audit.
2. signAction: update transaction.raw_tx/txid/processing + audit.
3. processBroadcastResult: update transaction.processing + cascade outputs.spendable + (on failure) restore inputs + audit.
4. internalizeAction (proof or no-proof): upsert transaction + upsert action + insert outputs + audit.
5. abortAction: update action + cascade this user's outputs.spendable + audit.
6. Reorg invalidation: update transaction + cascade outputs (across all users) + audit.
7. Reprove success: update transaction + cascade outputs + audit.
8. Coinbase maturity flip: per-batch.
9. Unfail decision: update transaction + cascade outputs + restore inputs (or not, per result) + audit.
10. Reconcile correction.

### 10.2 Write ordering inside a transaction

1. `chain_tip` read (or write if TipTracker).
2. `transactions` upsert.
3. `actions` upsert.
4. `outputs` spent_by / spendable cascade.
5. `tx_audit` inserts.

### 10.3 Isolation

Minimum READ COMMITTED + `row_version` OCC. SQLite SERIALIZABLE.

---

## 11. Audit log

### 11.1 Canonical event tags

| `what` | Emitted by | Scope |
|---|---|---|
| `createAction` | createAction | action + transaction |
| `signAction` | signAction | transaction |
| `abortAction` | abortAction | action only |
| `internalizeAction` | internalizeAction | action + transaction |
| `broadcastAttempt` | per-provider broadcast call | transaction |
| `broadcastProviderResult` | per-provider result | transaction |
| `aggregateResult` | broadcast aggregation | transaction |
| `sseEvent` | ArcSSE listener | transaction |
| `proofFetchAttempt` | sync task | transaction |
| `proofAcquired` | sync task | transaction |
| `proofPromotedToConfirmed` | depth promotion | transaction |
| `reorgInvalidatedProof` | reorg task | transaction |
| `reproveSuccess` | reprove task | transaction |
| `reproveExhausted` | reprove task | transaction |
| `coinbaseMatured` | maturity task | transaction (with output details) |
| `coinbaseLost` | reorg → frozen | transaction |
| `unfailAttempt` | unfail task | transaction |
| `rebroadcastCycle` | circuit-breaker | transaction |
| `failedAbandoned` | reaper | transaction |
| `reconcileDrift` | reconcile task | output-level (in details_json) |
| `tipAdvanced` | tip tracker | no scope |
| `lateReceiptReconciled` | processBroadcastReceipts | transaction |

### 11.2 Retention

`AuditRetentionDays` default 90.

---

## 12. Monitor tasks

Same set as v4. Updated to scan `transactions` directly (no longer `proven_txs`).

| Task | Cadence | Reads | Writes |
|---|---|---|---|
| `TipTracker` | ≤60s | chain services | `chain_tip` |
| `SendWaiting` | ≤30s | `transactions WHERE processing='queued' AND next_action_at <= now()` (with user_nosend filter via JOIN to `actions`) | `transactions.processing`, cascade outputs.spendable |
| `CheckForProofs` | on tip change | `transactions WHERE processing IN ('sent','seen','seen_multi','unconfirmed')` | proof fields, processing advances |
| `ArcSSE` | persistent stream | Arcade SSE | `transactions.processing`, audit |
| `CheckNoSends` | every `CheckNoSendPeriodHours` | `transactions WHERE processing='nosend'` | maybe processing advance |
| `Reorg` | event + 5 min sweep | `transactions WHERE processing='reorging'` | proof + processing |
| `CoinbaseMaturity` | on tip change | `outputs WHERE is_coinbase AND NOT spendable AND matures_at_height <= tip` | `outputs.spendable` |
| `Reaper` | hourly | abandoned `draft`/`queued` rows | `processing → invalid` or `frozen` |
| `UnFail` | ≤10 min | `transactions WHERE processing='unfail'` | per §11 |
| `Reconcile` | every 30 min | sliding window of outputs | `spendable` corrections, audit |
| `ProcessBroadcastReceipts` | every 5 min | late receipts via idempotency_key | processing advance, audit |
| `AuditPrune` | daily | aged audit rows | archive/delete |

All tasks acquire `monitor_lease` before running.

---

## 13. Configuration

| Constant | Default |
|---|---|
| `MinConfirmationDepth` | 1 |
| `CoinbaseMaturity` | 100 |
| `MaxProofAttempts` | 100 |
| `MaxRebroadcastAttempts` | 0 (unlimited) |
| `CheckNoSendPeriodHours` | 24 |
| `FailAbandonedAgeSeconds` | 3600 |
| `BroadcastSoftTimeoutMs` | 5000 |
| `BroadcastSoftTimeoutPerKbMs` | 50 |
| `BroadcastSoftTimeoutMaxMs` | 30000 |
| `ReorgAgeMsecs` | 600000 |
| `ReorgMaxRetries` | 3 |
| `MonitorLeaseSeconds` | 60 |
| `AuditRetentionDays` | 90 |

---

## 14. Conformance tests

### 14.1 FSM coverage

For each legal transition in §4, named test `T_FSM_<from>_to_<to>`.

### 14.2 Lifecycle derivation

- `T_LIFE_01_derived_at_read_time` — listActions returns deterministic lifecycle from current processing + flags. Underlying data changes, derived lifecycle changes immediately.
- `T_LIFE_02_aborted_overrides_processing` — user abort flips THIS user's derived lifecycle to 'aborted' and outputs.spendable to false; other users sharing the txid see no change.
- `T_LIFE_03_hidden_overrides` — hidden flag returns 'hidden' regardless of processing.

### 14.3 Schema parity

- `T_SCHEMA_01_columns_match`.
- `T_SCHEMA_02_indexes_match`.
- `T_SCHEMA_03_ts_writes_go_reads`.
- `T_SCHEMA_04_go_writes_ts_reads`.
- `T_SCHEMA_05_no_legacy_tables` (`proven_tx_reqs`, `proven_txs`, `known_txs`, `user_utxos`, old per-user `transactions.status`).
- `T_SCHEMA_06_transactions_unique_per_txid` — `transactions.txid` UNIQUE constraint enforced.
- `T_SCHEMA_07_actions_unique_per_user_tx` — `(userId, transactionId)` UNIQUE.

### 14.4 Multi-user dedupe

- `T_MULTIUSER_01_shared_transaction` — two users internalize the same txid; one `transactions` row, two `actions` rows.
- `T_MULTIUSER_02_one_proof_many_users` — proof acquisition updates one `transactions` row; both users' actions return derived lifecycle 'confirmed'.
- `T_MULTIUSER_03_cascade_outputs_one_update` — proof advance triggers a single SQL UPDATE on outputs joined by `transactionId`.
- `T_MULTIUSER_04_per_user_abort` — abort affects only the calling user's outputs/action, not the other user's.
- `T_MULTIUSER_05_reorg_cascade` — reorg invalidates one transaction; both users see derived lifecycle 'pending'.

### 14.5 Processing pipeline

- `T_PROC_BROADCAST_01_arc_happy` — `queued → sending → sent → seen → unconfirmed → proven`.
- `T_PROC_BROADCAST_02_arcade_full` — `queued → sending → sent → seen → seen_multi → unconfirmed → proven`.
- `T_PROC_BROADCAST_03_woc_skip` — `queued → sending → sent → unconfirmed → proven` (no `seen`).
- `T_PROC_BROADCAST_04_serviceError_returns_to_queued` — provider fails → `queued`, never stuck in `sending`.
- `T_PROC_BROADCAST_05_no_regression` — stale poll reporting earlier status is ignored.
- `T_PROC_BROADCAST_06_sse_event_mapping` — every ARC/Arcade event string maps correctly.
- `T_PROC_BROADCAST_07_sequential_only` — no parallel `.All` broadcast.
- `T_PROC_BROADCAST_08_idempotency_key_reused`.
- `T_PROC_BROADCAST_09_user_nosend_blocks_send` — if every linked action has `user_nosend=true`, `SendWaiting` does not pick up the row.
- `T_PROC_BROADCAST_10_one_user_clears_nosend_unblocks` — if any one action has `user_nosend=false`, the row becomes eligible.

### 14.6 Aggregation

- `T_AGG_01_success_wins_over_doubleSpend`.
- `T_AGG_02_invalid_only_after_all_fail`.
- `T_AGG_03_serviceError_never_marks_invalid`.

### 14.7 Coinbase

- `T_COINBASE_01_detected_at_index_zero`.
- `T_COINBASE_02_matures_at_height_set`.
- `T_COINBASE_03_unspendable_before_maturity`.
- `T_COINBASE_04_spendable_at_exact_maturity`.
- `T_COINBASE_05_reorg_lost_freezes` — `processing → frozen, frozen_reason = 'coinbaseLost'`.
- `T_COINBASE_06_listOutputs_filters_immature`.

### 14.8 Reorg

- `T_REORG_01_proven_to_reorging`.
- `T_REORG_02_reorging_to_unconfirmed_on_reprove`.
- `T_REORG_03_outputs_unspendable_during_reorging` — v5 change: outputs flip to false during reorging.
- `T_REORG_04_outputs_spendable_again_after_reprove`.
- `T_REORG_05_never_invalid_non_coinbase`.

### 14.9 Output cache integrity

- `T_OUTPUT_01_failed_outputs_unspendable`.
- `T_OUTPUT_02_inputs_restored_on_failure`.
- `T_OUTPUT_03_reconcile_detects_drift`.
- `T_OUTPUT_04_no_side_index_read`.
- `T_OUTPUT_05_input_selection_one_index_seek` — explain plan shows single index range scan on `(userId, spendable, basketId, satoshis)`.

### 14.10 Concurrency

- `T_CONC_01_lease_exclusivity`.
- `T_CONC_02_lease_expires_on_crash`.
- `T_CONC_03_row_version_conflict_retry`.
- `T_CONC_04_concurrent_users_one_transaction` — two users internalize the same txid concurrently; only one `transactions` row exists at the end.

### 14.11 Audit

- `T_AUDIT_01_every_transition_logged`.
- `T_AUDIT_02_canonical_what_tags`.
- `T_AUDIT_03_provider_status_preserved`.
- `T_AUDIT_04_scope_correct` — `transactionId`-only events have NULL `actionId`; action events have non-NULL `actionId`.

### 14.12 Cross-runtime soak

- `T_SOAK_01_alternating_runtimes`.

---

## 15. Migration plan

### 15.1 Shared migration

From either TS or Go starting state, the migration:

1. Creates the new `actions` table.
2. Backfills `actions` from existing per-user `transactions` rows (one new `actions` row per old `transactions` row, copying `userId`, `reference`, `description`, `is_outgoing`, `satoshis_delta`, etc.).
3. Deduplicates `transactions` rows by `txid` (where multi-user wallets had N rows per txid, collapses to one).
4. Re-keys `outputs.transactionId` to point at the deduplicated row.
5. Re-keys `tx_labels_map.transactionId` to `actionId` (since labels are per-user, the right FK is `actionId`).
6. Migrates per-txid columns from current `transactions` + `proven_tx_reqs` + `proven_txs` (TS) or `known_txs` (Go) into the new merged `transactions`.
7. Adds new columns: `processing`, `idempotency_key`, `last_provider`, `last_provider_status`, `is_coinbase`, `matures_at_height` (on outputs), `frozen_reason`, `row_version`.
8. Re-derives `outputs.spendable` per §2.4.
9. Drops legacy tables: `proven_tx_reqs`, `proven_txs` (TS); `known_txs`, `user_utxos` (Go); legacy `transactions.status` column.
10. Creates `chain_tip`, `tx_audit`, `monitor_lease`.

```sql
-- Sketch (dialect-specific in detail):

-- 1. Create new actions table
CREATE TABLE actions (
  actionId BIGINT PRIMARY KEY AUTO_INCREMENT,
  userId BIGINT NOT NULL,
  transactionId BIGINT NOT NULL,
  reference VARCHAR(64) NOT NULL UNIQUE,
  description VARCHAR(2048) NOT NULL,
  is_outgoing BOOLEAN NOT NULL,
  satoshis_delta BIGINT NOT NULL DEFAULT 0,
  user_nosend BOOLEAN NOT NULL DEFAULT FALSE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  user_aborted BOOLEAN NOT NULL DEFAULT FALSE,
  notify_json LONGTEXT NOT NULL DEFAULT '{}',
  row_version BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE (userId, transactionId),
  FOREIGN KEY (userId) REFERENCES users(userId),
  FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
);

-- 2. Backfill actions from existing per-user transactions
INSERT INTO actions (userId, transactionId, reference, description, is_outgoing, satoshis_delta, user_nosend, notify_json, created_at, updated_at)
SELECT userId, transactionId, reference, description, isOutgoing, satoshis,
       CASE status WHEN 'nosend' THEN TRUE ELSE FALSE END,
       '{}',
       created_at, updated_at
FROM transactions;

-- 3. Deduplicate transactions by txid
-- Strategy: keep the row with the most-advanced status; rewrite outputs' transactionId FKs.
CREATE TEMPORARY TABLE _tx_canonical AS
SELECT txid,
       MIN(transactionId) AS canonical_id
FROM transactions
WHERE txid IS NOT NULL
GROUP BY txid;

UPDATE outputs o
   SET transactionId = c.canonical_id
  FROM _tx_canonical c, transactions t
 WHERE t.transactionId = o.transactionId
   AND t.txid = c.txid
   AND t.transactionId != c.canonical_id;

UPDATE actions a
   SET transactionId = c.canonical_id
  FROM _tx_canonical c, transactions t
 WHERE t.transactionId = a.transactionId
   AND t.txid = c.txid
   AND t.transactionId != c.canonical_id;

DELETE FROM transactions WHERE transactionId NOT IN (SELECT canonical_id FROM _tx_canonical)
  AND txid IS NOT NULL;

-- 4. Strip per-user columns from transactions
ALTER TABLE transactions
  DROP COLUMN userId,
  DROP COLUMN reference,
  DROP COLUMN description,
  DROP COLUMN isOutgoing,
  DROP COLUMN satoshis;

-- 5. Migrate proven_tx_reqs (TS) / known_txs (Go) state into transactions
ALTER TABLE transactions
  ADD COLUMN processing VARCHAR(20),
  ADD COLUMN processing_changed_at DATETIME,
  ADD COLUMN next_action_at DATETIME,
  ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN rebroadcast_cycles INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN was_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN idempotency_key VARCHAR(64),
  ADD COLUMN batch VARCHAR(64),
  ADD COLUMN is_coinbase BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN last_provider VARCHAR(40),
  ADD COLUMN last_provider_status VARCHAR(40),
  ADD COLUMN frozen_reason VARCHAR(40),
  ADD COLUMN row_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN height INT UNSIGNED,
  ADD COLUMN merkle_index INT UNSIGNED,
  ADD COLUMN merkle_path BLOB,
  ADD COLUMN merkle_root VARCHAR(64),
  ADD COLUMN block_hash VARCHAR(64);

-- map old status → processing
UPDATE transactions SET processing = CASE
  WHEN EXISTS(SELECT 1 FROM proven_tx_reqs r WHERE r.txid = transactions.txid)
    THEN (SELECT
      CASE r.status
        WHEN 'unsent'      THEN 'queued'
        WHEN 'unprocessed' THEN 'queued'
        WHEN 'nosend'      THEN 'nosend'
        WHEN 'nonfinal'    THEN 'nonfinal'
        WHEN 'sending'     THEN 'queued'  -- restart in-flight
        WHEN 'unmined'     THEN 'sent'
        WHEN 'callback'    THEN 'sent'
        WHEN 'unconfirmed' THEN 'unconfirmed'
        WHEN 'completed'   THEN 'proven'
        WHEN 'invalid'     THEN 'invalid'
        WHEN 'doubleSpend' THEN 'doubleSpend'
        WHEN 'unfail'      THEN 'unfail'
        ELSE 'queued'
      END FROM proven_tx_reqs r WHERE r.txid = transactions.txid LIMIT 1)
  ELSE 'queued'
END;

-- Backfill proof fields from proven_txs (TS) / known_txs (Go)
UPDATE transactions t
   SET height = pt.height,
       merkle_index = pt.index,
       merkle_path = pt.merklePath,
       merkle_root = pt.merkleRoot,
       block_hash = pt.blockHash,
       is_coinbase = (pt.index = 0)
  FROM proven_txs pt
 WHERE t.txid = pt.txid;

-- 6. Add outputs columns
ALTER TABLE outputs
  ADD COLUMN is_coinbase BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN matures_at_height INT UNSIGNED,
  ADD COLUMN row_version BIGINT NOT NULL DEFAULT 0;

UPDATE outputs o
   SET is_coinbase = TRUE,
       matures_at_height = t.height + 100
  FROM transactions t
 WHERE o.transactionId = t.transactionId AND t.is_coinbase = TRUE;

-- 7. Re-derive outputs.spendable
UPDATE outputs SET spendable = ( … §6.1 derivation … );

-- 8. Update tx_labels_map FK
ALTER TABLE tx_labels_map
  ADD COLUMN actionId BIGINT;
UPDATE tx_labels_map m
   SET actionId = (SELECT a.actionId FROM actions a
                    WHERE a.transactionId = m.transactionId AND a.userId = (SELECT userId FROM tx_labels WHERE tx_labels.txLabelId = m.txLabelId)
                    LIMIT 1);
ALTER TABLE tx_labels_map DROP COLUMN transactionId;

-- 9. Create new tables
CREATE TABLE chain_tip (...);
CREATE TABLE tx_audit (...);
CREATE TABLE monitor_lease (...);

-- 10. Drop legacy
DROP TABLE proven_tx_reqs;
DROP TABLE proven_txs;
DROP TABLE known_txs;       -- Go
DROP TABLE user_utxos;       -- Go

-- 11. Add indexes (per §3.x)
-- ...
```

### 15.2 Rollout

Migration is one-shot. After it runs, both v5-capable runtimes can operate against the DB. No mixed-version interop; pre-v5 code MUST NOT run against a v5-migrated DB.

---

## 16. Out of scope

- Multi-tenant sharding across DBs (v6).
- Wallet-to-wallet sync protocol changes (BRC concern).
- Hardware-wallet signing protocols.
- Per-output RBF beyond `sequence_number`.

---

## 17. Glossary

| Term | Definition |
|---|---|
| **Action** | A user's view of a transaction. One per (user, txid). BRC-100 vocabulary. |
| **Transaction** | A network entity identified by txid. One row in `transactions` regardless of how many users observe it. |
| **Arcade** | Next-generation BSV broadcaster (HTTPS + SSE). Emits full pipeline including `SEEN_MULTIPLE_NODES`. |
| **ARC** | Current BSV broadcaster API. Polled. Up to `SEEN_ON_NETWORK`. |
| **BEEF** | BRC-62 envelope. |
| **BUMP** | BRC-74 merkle path. |
| **chain_tip** | Wallet's view of chain head. |
| **coinbase** | First tx in a block; merkle leaf offset 0. |
| **derived lifecycle** | The per-user user-visible status, computed at read time from `transactions.processing` + `actions` flags. Not stored. |
| **frozen** | Terminal-but-recoverable state. `frozen_reason` distinguishes. |
| **idempotency_key** | Per-txid token reused across broadcast retries. |
| **monitor_lease** | Cooperative worker exclusion. |
| **processing** | Per-txid FSM on `transactions`. Single source of truth for network state. |
| **reorging** | Transient state after orphan detection, awaiting reprove. |
| **row_version** | Optimistic-locking counter. |
| **sent / seen / seen_multi** | Granular states inside the broadcast pipeline. |
| **user_nosend** | Per-user flag indicating this user does not want their wallet to broadcast this tx. |
| **user_aborted** | Per-user flag indicating this user soft-aborted the action. |

---

**End of PROD_REQ_V5.md.**
