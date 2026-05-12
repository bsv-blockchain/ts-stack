# PROD_REQ_V4.md — BSV Wallet UTXO & Transaction Lifecycle Specification

**Version:** 4.0
**Date:** 2026-05-11
**Status:** Draft. Supersedes v3.

---

## 0. What changed in v4

Two architectural decisions made for v4:

1. **Per-txid state lives on `proven_txs`, per-user state lives on `transactions`.** v3 collapsed `proven_tx_reqs` into `transactions`, which forced every user sharing a txid to maintain their own broadcast/proof FSM. That is wrong. Broadcast happens once per txid; proof exists once per txid. **`proven_tx_reqs` is merged into `proven_txs` (not into `transactions`).** Per-user fields stay on `transactions`. See §2.1 for the rationale.

2. **`tx.processing` enum gains broadcast-pipeline granularity.** v3 had coarse `sending`/`unmined`/`callback` values. v4 replaces these with `queued → sending → sent → seen → seen_multi → unconfirmed → proven`, reflecting how ARC and Arcade actually report state. Services that don't emit intermediate states (WhatsOnChain, Bitails) skip them. See §4.2 and §7.

Everything else in v3 (sequential broadcast, coinbase maturity, reorg as a transient state, output spendability derivation, audit log, monitor leasing, optimistic concurrency, idempotency keys, conformance suite) is carried forward.

---

## 1. Architectural overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Application (BRC-100 wallet API)                                  │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────┴────────────────────────────────────────────────────────┐
│  Action orchestrators                                              │
│  createAction · signAction · internalizeAction · listOutputs       │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────┴────────────────────────────────────────────────────────┐
│  Storage                                                            │
│  ─ transactions     (per-user lifecycle)                            │
│  ─ outputs          (per-user UTXO state)                           │
│  ─ proven_txs       (per-txid processing + proof + raw_tx)          │
│  ─ chain_tip        (singleton chain head)                          │
│  ─ tx_audit         (per-event log)                                 │
│  ─ monitor_lease    (cooperative worker exclusion)                  │
│  ─ users, baskets, labels, tags, certs, commissions, …              │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────┴────────────────────────────────────────────────────────┐
│  Monitor tasks (run under lease)                                    │
│  TipTracker · SendWaiting · CheckForProofs · CheckNoSends ·          │
│  Reorg · CoinbaseMaturity · Reaper · UnFail · Reconcile ·            │
│  ProcessBroadcastReceipts · AuditPrune                              │
└──────────┬────────────────────────────────────────────────────────┘
           │
┌──────────┴────────────────────────────────────────────────────────┐
│  Services  (ARC, Arcade SSE, WhatsOnChain, Bitails, chaintracks)    │
└────────────────────────────────────────────────────────────────────┘
```

### 1.1 Action / monitor split

- **Action layer** writes inside one DB transaction. Never blocks on external services.
- **Monitor layer** owns service calls. Reads work-queue tables, calls services, writes back inside another DB transaction.

Broadcast attempts happen exclusively in the monitor layer (`SendWaiting` task). Action calls return immediately; the caller polls or subscribes to a webhook for status changes.

### 1.2 Cardinality

| Entity | Scale | Hot read | Hot write |
|---|---|---|---|
| `transactions` | 10⁶ – 10⁹ per server | by (userId, lifecycle) | append + lifecycle update |
| `outputs` | 10⁶ – 10⁹ per server | by (userId, spendable, basketId, satoshis) | append + flip |
| `proven_txs` | 10⁶ – 10⁸ | by txid, by (processing, next_action_at) | append + processing update |
| `tx_audit` | 10⁷ – 10¹⁰ | by (transactionId, at) | append-only |

---

## 2. Domain model

### 2.1 Two tables, two FSMs, one source of truth per axis

| Axis | Lives on | Cardinality | Owner |
|---|---|---|---|
| `lifecycle` | `transactions` | one row per (user, txid) | derived from `proven_txs.processing` + reorg flips |
| `processing` | `proven_txs` | one row per txid | monitor tasks |
| Proof data (BUMP, height, block_hash, merkle_root, merkle_index, raw_tx) | `proven_txs` | one row per txid | sync task |
| Output spendability | `outputs.spendable` (cached) | one row per output | trigger of any lifecycle / spent_by / tip change |

This split solves three problems:

1. **Multi-user wallets.** A server-side wallet may have many users receiving the same txid (e.g., multi-sig vaults, multi-account HD wallets). One broadcast, one proof, many `transactions` rows. v3 would have forced N copies of broadcast state.
2. **Broadcast/proof concurrency.** Monitor tasks scan `proven_txs` by processing state. One queue, not N.
3. **Reorg cost.** Invalidating a proof updates one `proven_txs` row + cascades to its N `transactions` rows. Without this split, a reorg would do N broadcast-state resets.

The trade-off: every list query that needs lifecycle joins to `proven_txs` for the latest processing. To keep this cheap, `lifecycle` is **denormalized** to `transactions.lifecycle`. It is updated atomically with every `proven_txs.processing` change by the same SQL transaction (cost: `UPDATE transactions WHERE provenTxId = ?`, indexed). For a single-user wallet that's 1 row; for a server it's N. Still cheaper than N independent processing FSMs.

### 2.2 Spendability — formal predicate

```
spendable_derived =
   transactions.lifecycle IN ('pending', 'confirmed', 'nosend')   -- nosend included only if includeNoSend flag
   AND outputs.spent_by IS NULL
   AND outputs.locking_script IS NOT NULL
   AND (NOT outputs.is_coinbase OR outputs.matures_at_height <= chain_tip.height)
```

`outputs.spendable` is a cache of this predicate. The `Reconcile` task (§12) periodically verifies the cache matches. Disagreements log `tx_audit.what='reconcileDrift'` at error severity.

### 2.3 Idempotency keys

Generated at action time, stored on `proven_txs.idempotency_key`. Reused across every broadcast attempt for the same txid. Providers honoring the key (ARC) dedupe; others are detected by txid comparison on the response.

### 2.4 Optimistic concurrency

`row_version` on every mutable table: `transactions`, `outputs`, `proven_txs`, `chain_tip`, `monitor_lease`. Every update statement specifies `WHERE row_version = ?` and increments. Concurrent workers retry on conflict.

---

## 3. Schema (v4)

Both implementations realize this schema with identical column names, types, constraints, indexes. Implementations MAY add more indexes; they MUST NOT drop normative ones.

### 3.1 `transactions` (per-user)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `transactionId` | bigint, auto-inc | PK | |
| `userId` | bigint | FK → users, NOT NULL, indexed | |
| `provenTxId` | bigint | FK → proven_txs, NOT NULL | Inserted alongside on createAction |
| `txid` | varchar(64) NULL | indexed | Denormalized from `proven_txs.txid` for index seeks; nullable until first signing |
| `reference` | varchar(64) | NOT NULL, UNIQUE | Random base64 |
| `lifecycle` | varchar(20) | NOT NULL, indexed | §4.1 |
| `is_outgoing` | boolean | NOT NULL | |
| `satoshis_delta` | bigint | NOT NULL, default 0 | Net wallet delta for this user |
| `description` | varchar(2048) | NOT NULL | |
| `version` | int unsigned NULL | | |
| `lock_time` | int unsigned NULL | | |
| `notify_json` | longtext | NOT NULL, default `'{}'` | Per-user notification subscribers |
| `lifecycle_changed_at` | datetime | NOT NULL | |
| `row_version` | bigint | NOT NULL, default 0 | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

Note: `raw_tx`, `input_beef`, `attempts`, `rebroadcast_cycles`, `was_broadcast`, `batch`, `is_coinbase`, `next_action_at` are NOT on this table. They live on `proven_txs`.

**Required indexes:**
- `(userId, lifecycle, transactionId)` — listActions
- `(provenTxId)` — proof updates cascade here
- `(txid)` — txid lookup
- `(reference)` — UNIQUE

### 3.2 `outputs` (per-user)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `outputId` | bigint, auto-inc | PK | |
| `userId` | bigint | FK → users, NOT NULL | |
| `transactionId` | bigint | FK → transactions, NOT NULL | |
| `vout` | int | NOT NULL | |
| `basketId` | bigint NULL | FK → output_baskets | |
| `txid` | varchar(64) NULL | denormalized from owning tx for index seek | |
| `satoshis` | bigint | NOT NULL | |
| `locking_script` | binary NULL | | |
| `script_length` | bigint unsigned NULL | | |
| `script_offset` | bigint unsigned NULL | | |
| `type` | varchar(50) | NOT NULL | |
| `purpose` | varchar(20) | NOT NULL | |
| `provided_by` | varchar(20) | NOT NULL | |
| `change` | boolean | NOT NULL, default false | |
| `is_coinbase` | boolean | NOT NULL, default false | Denormalized from `proven_txs` |
| `matures_at_height` | int unsigned NULL | | Set if coinbase: `proven_txs.height + CoinbaseMaturity` |
| `spendable` | boolean | NOT NULL, default false, indexed | Cached derivation |
| `spent_by` | bigint NULL | FK → transactions.transactionId, indexed | |
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

**Required indexes:**
- `(userId, spendable, basketId, satoshis)` — input selection
- `(userId, spendable, outputId)` — pagination
- `(spent_by)`
- `(txid, vout)`
- `(matures_at_height) WHERE is_coinbase AND NOT spendable` — coinbase maturity sweep

### 3.3 `proven_txs` (per-txid)

This is the merged successor of TS's `proven_txs` + `proven_tx_reqs` and Go's `known_txs`. One row per network txid. Holds processing state, broadcast counters, raw tx, BEEF, and (when acquired) proof data.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `provenTxId` | bigint, auto-inc | PK | |
| `txid` | varchar(64) | NOT NULL, UNIQUE, indexed | |
| `processing` | varchar(20) | NOT NULL, indexed | §4.2 |
| `processing_changed_at` | datetime | NOT NULL | |
| `next_action_at` | datetime NULL | indexed | When monitor should next look |
| `attempts` | int unsigned | NOT NULL, default 0 | Proof-fetch attempts |
| `rebroadcast_cycles` | int unsigned | NOT NULL, default 0 | Circuit-breaker |
| `was_broadcast` | boolean | NOT NULL, default false | First-acceptance latch |
| `idempotency_key` | varchar(64) | NOT NULL | Generated at insert |
| `batch` | varchar(64) NULL | indexed | Batch grouping |
| `raw_tx` | binary | NOT NULL | |
| `input_beef` | binary NULL | | Discardable after proof acquired |
| `height` | int unsigned NULL | indexed | Set when proof acquired |
| `merkle_index` | int unsigned NULL | | 0 ⇒ coinbase (§9.1) |
| `merkle_path` | binary NULL | | BUMP-encoded |
| `merkle_root` | varchar(64) NULL | | |
| `block_hash` | varchar(64) NULL | indexed | For reorg invalidation |
| `is_coinbase` | boolean | NOT NULL, default false | Set when merkle_index becomes known and equals 0 |
| `last_provider` | varchar(40) NULL | | Last broadcaster that touched this row (audit) |
| `last_provider_status` | varchar(40) NULL | | Raw provider-level status string (e.g., ARC `SEEN_ON_NETWORK`) |
| `row_version` | bigint | NOT NULL, default 0 | |
| `created_at` | datetime | NOT NULL | |
| `updated_at` | datetime | NOT NULL | |

**Required indexes:**
- `(txid)` UNIQUE
- `(processing, next_action_at)` — work-queue scan
- `(block_hash)` — reorg invalidation
- `(height)` — maturity / proof sweeps
- `(batch)` — batch broadcast

**Atomicity rule:** any update to `processing` MUST be accompanied, in the same DB transaction, by an `UPDATE transactions SET lifecycle = ?, lifecycle_changed_at = ?, row_version = row_version + 1 WHERE provenTxId = ?` per §5 mapping. The two columns are kept in lock-step.

### 3.4 `chain_tip` (singleton)

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | int | PK, fixed = 1 | |
| `height` | int unsigned | NOT NULL | |
| `block_hash` | varchar(64) | NOT NULL | |
| `merkle_root` | varchar(64) | NOT NULL | |
| `observed_at` | datetime | NOT NULL | |
| `row_version` | bigint | NOT NULL, default 0 | |

### 3.5 `tx_audit`

| Column | Type | Notes |
|---|---|---|
| `auditId` | bigint, auto-inc PK | |
| `transactionId` | bigint NULL, indexed | NULL when event is per-txid only (e.g., broadcast attempt for shared txid) |
| `provenTxId` | bigint NULL, indexed | Non-NULL for proven_txs-level events |
| `at` | datetime, indexed | |
| `what` | varchar(40), indexed | §11.1 |
| `actor` | varchar(40) | |
| `from_lifecycle` | varchar(20) NULL | |
| `to_lifecycle` | varchar(20) NULL | |
| `from_processing` | varchar(20) NULL | |
| `to_processing` | varchar(20) NULL | |
| `details_json` | longtext NULL | |

Required indexes: `(transactionId, at DESC)`, `(provenTxId, at DESC)`, `(what, at DESC)`.

### 3.6 `monitor_lease`

| Column | Type | Notes |
|---|---|---|
| `task_name` | varchar(40), PK | |
| `worker_id` | varchar(64), NOT NULL | |
| `acquired_at` | datetime, NOT NULL | |
| `expires_at` | datetime, NOT NULL, indexed | |
| `row_version` | bigint, NOT NULL, default 0 | |

### 3.7 Unchanged tables

`users`, `certificates`, `certificate_fields`, `output_baskets`, `output_tags`, `output_tags_map`, `tx_labels`, `tx_labels_map`, `commissions`, `monitor_events`, `settings`, `sync_states`.

### 3.8 Dropped tables

- `proven_tx_reqs` (TS) — merged into `proven_txs`.
- `known_txs` (Go) — merged into `proven_txs`.
- `user_utxos` (Go) — replaced by `outputs.spendable` derivation.

---

## 4. Status enums (v4)

### 4.1 `transactions.lifecycle` (per-user, application-visible)

| Value | Meaning |
|---|---|
| `draft` | Created, not yet signed. |
| `queued` | Signed; awaiting first broadcast OR retrying after service failure. |
| `nosend` | Signed, intentionally not broadcast by this wallet. |
| `nonfinal` | nLockTime in the future. |
| `pending` | Broadcast in flight OR accepted/seen but not yet confirmed at depth. |
| `confirmed` | Proof acquired AND depth ≥ `MinConfirmationDepth`. |
| `failed` | Terminal: rejected by all broadcasters, or confirmed double-spend. |
| `frozen` | Terminal-but-recoverable: admin freeze, or coinbase lost on reorg. |

### 4.2 `proven_txs.processing` (per-txid, monitor-visible)

```
                          ┌──────────┐
                          │  queued  │ ◄────── initial state on insert
                          └────┬─────┘ ◄────── retry destination after serviceError
                               │
                               │  SendWaiting picks up
                               ▼
                          ┌──────────┐
                          │  sending │  HTTP request in flight to a broadcaster
                          └────┬─────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   serviceError /          provider                provider rejects:
   soft-timeout           accepted (2xx)           statusError / invalid
        │                      │                      │
        ▼                      ▼                      ▼
   ┌────────┐             ┌────────┐            ┌──────────┐
   │ queued │◄────────────│  sent  │            │ invalid  │ (terminal — if all
   └────────┘             └────┬───┘            └──────────┘  attempted services rejected)
                               │
                               │ provider emits SEEN_ON_NETWORK (or equivalent)
                               ▼                              ┌────────────┐
                          ┌────────┐                          │doubleSpend │ (terminal —
                          │  seen  │                          └────────────┘  confirmed conflict)
                          └────┬───┘
                               │ provider emits SEEN_MULTIPLE_NODES (Arcade only)
                               ▼
                          ┌────────────┐
                          │ seen_multi │
                          └────┬───────┘
                               │ proof acquired by CheckForProofs
                               ▼
                          ┌───────────────┐
                          │  unconfirmed  │
                          └────┬──────────┘
                               │ depth ≥ MinConfirmationDepth
                               ▼
                          ┌─────────┐
                          │  proven │ (terminal happy path)
                          └─────────┘

REORG branch:
   proven ──block orphaned──► reorging ──reprove──► unconfirmed ──► proven
                              │
                  reproves exhausted, coinbase only
                              ▼
                       lifecycle=frozen
                       processing=reorging (sticky)

ADMIN branch:
   invalid | doubleSpend ──admin unfail──► unfail ──► queued (recover) or invalid (still bad)
```

Complete list:

| Value | Description |
|---|---|
| `queued` | Awaiting broadcast attempt. Initial state and post-`serviceError` retry destination. |
| `nosend` | Will not be broadcast by this wallet. |
| `nonfinal` | Awaiting nLockTime. |
| `sending` | Broadcast HTTP request in flight to current provider. |
| `sent` | A broadcaster returned a positive acceptance (HTTP 2xx with a non-rejection status). Tx is in that provider's pipeline. |
| `seen` | A broadcaster reports `SEEN_ON_NETWORK` (or equivalent — other miners see it). |
| `seen_multi` | A broadcaster reports `SEEN_MULTIPLE_NODES`. **Arcade only**; never reached for non-Arcade providers. |
| `unconfirmed` | Proof acquired; depth < `MinConfirmationDepth`. |
| `proven` | Depth ≥ `MinConfirmationDepth`. |
| `reorging` | Transient: proof invalidated by reorg; awaiting reprove. |
| `invalid` | Terminal: rejected by all broadcasters. |
| `doubleSpend` | Terminal: confirmed conflict via independent lookup. |
| `unfail` | Admin-triggered retry of a terminal failure. |

### 4.3 Service support matrix

Not every service emits every intermediate state. Implementations MUST tolerate skipped states and MUST NOT regress.

| Provider | Emits | Skipped |
|---|---|---|
| Arcade (ARC over SSE) | `sent`, `seen`, `seen_multi` | — |
| ARC (any other) | `sent`, `seen` | `seen_multi` |
| WhatsOnChain | `sent` | `seen`, `seen_multi` |
| Bitails | `sent` | `seen`, `seen_multi` |
| Generic mempool RPC | `sent` | `seen`, `seen_multi` |

**Skipping rule:** valid forward transitions on `processing` may skip intermediate states but MUST NOT regress. `sent → unconfirmed` is legal (a non-SEEN provider reports proof directly). `seen_multi → unconfirmed` is legal. `seen → sent` is NOT legal (regression).

Service-specific provider status strings are recorded in `proven_txs.last_provider_status` (raw) and `tx_audit.details_json` (full event payload). This preserves debuggability without bloating the enum.

### 4.4 Coupled (`lifecycle`, `processing`) pairs

The only legal coexistence pairs:

| `lifecycle` | Legal `processing` |
|---|---|
| `draft` | `queued` |
| `queued` | `queued`, `nonfinal`, `nosend` |
| `nosend` | `nosend` |
| `nonfinal` | `nonfinal` |
| `pending` | `queued` (retry), `sending`, `sent`, `seen`, `seen_multi`, `unconfirmed` |
| `confirmed` | `proven` |
| `failed` | `invalid`, `doubleSpend` |
| `frozen` | `invalid`, `doubleSpend`, `reorging` |

Any other pair is illegal. Enforce via CHECK constraint or application guard.

Note: `lifecycle=pending` while `processing=queued` is the post-serviceError retry state. The user sees "pending" through the entire post-sign retry/broadcast/seen/seen_multi/unconfirmed arc. Only `processing` distinguishes where exactly the tx is in the pipeline.

---

## 5. Coupling rules

When `proven_txs.processing` changes, the implementation MUST, in the **same DB transaction**:

1. Update `proven_txs.processing_changed_at`, increment `row_version`.
2. Update `transactions.lifecycle` for every row pointing at this `provenTxId` per the mapping below.
3. Re-derive `outputs.spendable` for every output of every affected `transactions` row per §2.2.
4. Append a `tx_audit` row (one per affected transaction; one per proven_tx for the processing change itself).

### 5.1 `processing → lifecycle` mapping

| `processing` | `lifecycle` |
|---|---|
| `queued` (initial, before first send) | `queued` |
| `queued` (post-serviceError retry) | `pending` |
| `nosend` | `nosend` |
| `nonfinal` | `nonfinal` |
| `sending`, `sent`, `seen`, `seen_multi`, `unconfirmed` | `pending` |
| `proven` | `confirmed` |
| `reorging` | `pending` (normal case) OR `frozen` (coinbase-lost case, §9.3) |
| `invalid`, `doubleSpend` | `failed` |
| `unfail` | preserves caller's lifecycle until resolution |

**The `queued` ambiguity** (initial vs retry) is resolved by `was_broadcast`:
- `processing='queued' AND was_broadcast=false` → `lifecycle='queued'`
- `processing='queued' AND was_broadcast=true` → `lifecycle='pending'`

This invariant MUST be enforced at every transition.

---

## 6. Output spendability rules

### 6.1 Derivation (canonical)

Per §2.2:

```
spendable_derived =
   transactions.lifecycle IN ('pending', 'confirmed')                          -- include 'nosend' iff includeNoSend
   AND outputs.spent_by IS NULL
   AND outputs.locking_script IS NOT NULL
   AND (NOT outputs.is_coinbase OR outputs.matures_at_height <= chain_tip.height)
```

### 6.2 Cache refresh triggers

The cached `outputs.spendable` MUST be refreshed atomically with each of:

- A `transactions.lifecycle` change for the owning tx.
- An `outputs.spent_by` change for this row.
- A `chain_tip.height` advance that crosses any `outputs.matures_at_height` for a coinbase output of this user.
- A reconciliation correction.

### 6.3 Forbidden behaviors

- MUST NOT consult any side index (e.g., legacy `user_utxos`) for input selection.
- MUST NOT flip `spendable` on a reorg directly (only via the lifecycle change).
- MUST NOT modify `spendable` during `unfail` beyond what §5.1 implies.
- MUST NOT use `processing` state directly in input-selection queries — that would couple per-user reads to per-txid state and amplify reads on multi-user wallets.

---

## 7. Broadcast pipeline (v4 detail)

### 7.1 Lifecycle inside the broadcaster

Each broadcast attempt walks the `proven_txs.processing` FSM as follows:

```
Initial: processing = queued, was_broadcast = false

SendWaiting picks row:
    UPDATE proven_txs SET processing = 'sending', next_action_at = NULL WHERE ...

For each provider in priority order:
    audit: broadcastAttempt (provider, idempotency_key)
    response = call provider with idempotency_key, soft-timeout

    case response:
        accepted (2xx with no rejection):
            UPDATE proven_txs SET
              processing = 'sent',
              was_broadcast = true,
              last_provider = <name>,
              last_provider_status = <raw>;
            audit: broadcastProviderResult (accepted)
            -- subsequent state changes (seen, seen_multi) come from SSE / polling
            break out of provider loop

        SEEN_ON_NETWORK (some providers report directly):
            UPDATE proven_txs SET processing = 'seen', was_broadcast = true, …
            break

        confirmed doubleSpend with independent verification:
            UPDATE proven_txs SET processing = 'doubleSpend', …
            audit: broadcastProviderResult (doubleSpend)
            break

        statusError (provider says invalid):
            audit: broadcastProviderResult (rejected)
            continue to next provider

        serviceError or soft-timeout:
            audit: broadcastProviderResult (serviceError)
            continue

If loop exits without break:
    UPDATE proven_txs SET processing = 'queued', next_action_at = now() + backoff
    audit: aggregateResult (serviceError or invalid)
    (lifecycle stays 'pending' since was_broadcast may already be true; if was_broadcast=false on the first cycle and all providers refused with statusError, → invalid)

If all attempted providers returned statusError and none returned serviceError or success:
    UPDATE proven_txs SET processing = 'invalid', …
```

### 7.2 Subsequent state advancement (post-`sent`)

After a row is in `sent`, the monitor's `CheckForProofs` task and an optional `ArcSSE` listener advance it:

| Trigger | Transition |
|---|---|
| ARC poll returns `SEEN_ON_NETWORK` | `sent → seen` |
| Arcade SSE pushes `SEEN_ON_NETWORK` | `sent → seen` |
| Arcade SSE pushes `SEEN_MULTIPLE_NODES` | `seen → seen_multi` |
| ARC poll returns `MINED` (or proof acquired) | any of `{sent, seen, seen_multi} → unconfirmed` |
| Depth check passes | `unconfirmed → proven` |
| Provider downgrades (e.g., `MINED` → `REJECTED` due to reorg) | recorded but does NOT regress; reorg path handles it via `processing → reorging` |
| Re-checks find no record | counts as a sync failure; `attempts++`; if `MaxProofAttempts` exceeded, circuit-breaker per §7.4 |

`processing` MUST NOT regress within the linear arc `sending → sent → seen → seen_multi → unconfirmed → proven`. Regressions are only valid in two cases:
- Forward transition to a terminal (`invalid`, `doubleSpend`) — not a regression, a fork.
- Reorg path (`proven → reorging`) — explicitly orthogonal.

### 7.3 Sequential ordering

Broadcast attempts to multiple providers happen **sequentially**. No parallel `.All` calls. After a positive response from any provider, the loop breaks. Subsequent providers are not consulted for that broadcast cycle. (Sync-time status polling MAY query multiple providers in parallel; that's a read, not a write.)

### 7.4 Soft timeouts & circuit breaker

- Per-provider timeout: `BroadcastSoftTimeoutMs + (beef_size_kib × BroadcastSoftTimeoutPerKbMs)`, capped at `BroadcastSoftTimeoutMaxMs`.
- After `MaxProofAttempts` proof-fetch failures with `was_broadcast = true`:
  - If `rebroadcast_cycles < MaxRebroadcastAttempts`: `processing → queued`, increment `rebroadcast_cycles`, retry from §7.1.
  - Otherwise: `processing → invalid`.
- After `MaxProofAttempts` with `was_broadcast = false`: `processing → invalid` immediately.

### 7.5 Late receipts

A broadcast attempt that soft-timed out MAY still deliver a successful response after the timeout (the HTTP response simply arrived late). The `ProcessBroadcastReceipts` task (§12) polls for late results using `idempotency_key` and reconciles. If reconciliation finds a previously-rejected tx is actually in mempool, it advances `processing` from wherever it is to `sent` and emits `tx_audit.what='lateReceiptReconciled'`.

### 7.6 SSE handling

The `ArcSSE` listener subscribes to Arcade's event stream. Each event carries `(txid, status, blockHeight?, merklePath?)`. Mapping into our FSM:

| ARC/Arcade event | Our `processing` |
|---|---|
| `RECEIVED`, `STORED`, `ANNOUNCED_TO_NETWORK`, `REQUESTED_BY_NETWORK`, `SENT_TO_NETWORK`, `ACCEPTED_BY_NETWORK` | `sent` |
| `SEEN_ON_NETWORK` | `seen` |
| `SEEN_MULTIPLE_NODES` | `seen_multi` |
| `SEEN_IN_ORPHAN_MEMPOOL` | `seen` (with audit note flagging orphan) |
| `MINED` | `unconfirmed` (then depth-promoted to `proven`) |
| `CONFIRMED` | `proven` |
| `REJECTED` | `invalid` (unless extraInfo indicates double-spend → `doubleSpend`) |

The mapping is a single function, identical in both implementations, with full test coverage (§15).

---

## 8. `internalizeAction`

### 8.1 BEEF with merkle proof

1. Verify scripts. Validate BUMP against chaintracks. Failure ⇒ abort, no rows persisted.
2. Open DB transaction.
3. Upsert `proven_txs`: `processing` set per depth check; `is_coinbase = (merkle_index == 0)`; `height`, `block_hash`, `merkle_root`, `merkle_index`, `merkle_path`, `raw_tx` populated; `was_broadcast = true` (someone broadcast it before us).
4. Insert/upsert `transactions` row with `provenTxId` from step 3, `lifecycle` per §5.1.
5. Insert `outputs`; compute `is_coinbase`, `matures_at_height`, `spendable` per §2.2 and §9.
6. Audit `internalizeAction`.
7. Commit.

Depth gate:
- `depth >= MinConfirmationDepth` ⇒ `proven_txs.processing = 'proven'`, `transactions.lifecycle = 'confirmed'`.
- `depth < MinConfirmationDepth` ⇒ `proven_txs.processing = 'unconfirmed'`, `transactions.lifecycle = 'pending'`.

### 8.2 BEEF without proof

1. Verify scripts. Open DB transaction.
2. Upsert `proven_txs`: `processing = 'queued'`, `was_broadcast = false`, `raw_tx`, `input_beef` populated.
3. Insert `transactions` with `lifecycle = 'queued'`.
4. Insert `outputs`. Outputs are NOT spendable yet (lifecycle is `queued`, not `pending` or `confirmed`).
5. Audit `internalizeAction`.
6. Commit. **Broadcast happens asynchronously** via `SendWaiting`.

The caller polls via `listActions` to observe progression. If `SendWaiting` later determines the tx is `invalid`, the row moves to `lifecycle='failed'` per the standard FSM. The application may call `abortAction` to clean up.

### 8.3 Multi-user idempotency

If the txid already exists in `proven_txs` (a different user already internalized this txid), the lookup short-circuits: existing `proven_txs` row is reused; a new `transactions` row is inserted for this user pointing at the same `provenTxId`. Lifecycle for the new row is derived from the current `processing` of the existing `proven_txs` via §5.1.

This is the multi-tenancy optimization §2.1 was designed for.

---

## 9. Coinbase

### 9.1 Detection

`proven_txs.merkle_index == 0 AND merkle_path IS NOT NULL ⇒ is_coinbase = true`. Set on `proven_txs.is_coinbase`. Cascaded to `outputs.is_coinbase`. Cascaded denormalization, not a join requirement.

### 9.2 Maturity

`outputs.matures_at_height = proven_txs.height + CoinbaseMaturity` (default 100). Coinbase outputs are `spendable = false` until `chain_tip.height >= matures_at_height`. The `CoinbaseMaturity` task (§12) flips `spendable` on the tip advance that crosses each maturity threshold.

### 9.3 Coinbase reorg

If a coinbase tx's block is orphaned:
1. Standard reorg flow: `proven_txs.processing = 'reorging'`, lifecycle on linked `transactions` rows → `pending`.
2. Reprove attempts up to `ReorgMaxRetries`.
3. If reprove succeeds: standard recovery via `unconfirmed → proven`. `matures_at_height` may be recomputed against the new height.
4. If reprove exhausts: `proven_txs.processing` stays `reorging`, but `transactions.lifecycle` is escalated to `frozen` (via the §5.1 mapping carve-out). Outputs flip to `spendable = false` via lifecycle change. Audit: `coinbaseLost`.

This is the only reorg path that produces a terminal-ish state. All non-coinbase reorgs are recoverable.

### 9.4 Listing

`listOutputs` MUST filter immature coinbase outputs by default. Opt-in via `includeImmature: true`.

---

## 10. Reorg handling

### 10.1 Detection

`TipTracker` task observes new chain tip from chaintracks / BlockHeaderService. If the new tip's hash differs from the previously recorded tip's hash at the same height, OR if the new tip's height ≤ the previous tip but with a different chain, a reorg is detected. Deactivated headers are computed locally or pulled from chaintracks.

### 10.2 Action

For each orphaned block hash:

1. Find `proven_txs` rows with `block_hash IN (orphanedHashes)`.
2. In one DB transaction per affected `proven_txs` row:
   - `proven_txs.processing = 'reorging'`, clear `height`, `block_hash`, `merkle_root`, `merkle_index`, `merkle_path`, set `attempts = 0`, `next_action_at = now() + ReorgAgeMsecs`.
   - Cascade `transactions.lifecycle = 'pending'` for all rows pointing at this `provenTxId`.
   - Re-derive `outputs.spendable` for the affected outputs (typically: unchanged, since `lifecycle='pending'` still satisfies §6.1).
   - Audit: `reorgInvalidatedProof(blockHash)` (one per affected transaction).
3. Schedule reprove via `Reorg` task.

### 10.3 Reprove

`Reorg` task scans `processing='reorging' AND next_action_at <= now()`:

- Calls `services.getMerklePath(txid)`.
- New path found, validates against chaintracks: insert/update `proven_txs` proof fields, `processing → 'unconfirmed'` (depth check by `CheckForProofs` later promotes to `proven`). Audit: `reproveSuccess`.
- Not found: `attempts++`; if `< ReorgMaxRetries`, reschedule (`next_action_at = now() + ReorgAgeMsecs * 2^attempts` for exponential backoff). If `>= ReorgMaxRetries`:
  - Coinbase: cascade lifecycle to `frozen`. Audit: `coinbaseLost`.
  - Non-coinbase: stay in `reorging` indefinitely at reduced cadence. The proof will likely resurface. Audit: `reproveExhausted`.

### 10.4 Reorg never marks invalid/doubleSpend

A reorg is a chain event, not evidence the tx was bad. The `processing → invalid` and `processing → doubleSpend` paths are reserved for broadcaster verdicts. Reorg only ever transitions through `reorging`.

---

## 11. Audit log

### 11.1 Canonical event tags

| `what` | Emitted by | Has lifecycle/processing diff? |
|---|---|---|
| `createAction` | createAction | yes |
| `signAction` | signAction | yes |
| `abortAction` | abortAction | yes |
| `internalizeAction` | internalizeAction | yes |
| `broadcastAttempt` | per-provider broadcast call | no (sub-event) |
| `broadcastProviderResult` | per-provider result | maybe |
| `aggregateResult` | broadcast aggregation | yes |
| `sseEvent` | ArcSSE listener | yes |
| `proofFetchAttempt` | sync task | no |
| `proofAcquired` | sync task | yes |
| `proofPromotedToConfirmed` | depth-gate promotion | yes |
| `reorgInvalidatedProof` | reorg task | yes |
| `reproveSuccess` | reprove task | yes |
| `reproveExhausted` | reprove task | maybe |
| `coinbaseMatured` | maturity task | no (output-level) |
| `coinbaseLost` | reorg → frozen | yes |
| `unfailAttempt` | unfail task | yes |
| `rebroadcastCycle` | circuit-breaker | yes |
| `failedAbandoned` | reaper | yes |
| `reconcileDrift` | reconcile task | no |
| `tipAdvanced` | tip tracker | no |
| `lateReceiptReconciled` | processBroadcastReceipts | maybe |

### 11.2 Required fields

Always: `at`, `what`, `actor`. At least one of `transactionId`, `provenTxId` (or both). State-change events populate `from_*` / `to_*`. Event-specific data in `details_json`.

### 11.3 Retention

`AuditRetentionDays` default 90. Configurable.

---

## 12. Monitor tasks

| Task | Cadence | Reads | Writes |
|---|---|---|---|
| `TipTracker` | ≤60s | chain services | `chain_tip` |
| `SendWaiting` | ≤30s | `proven_txs WHERE processing='queued' AND next_action_at <= now()` | `proven_txs.processing`, cascades |
| `CheckForProofs` | on tip change | `proven_txs WHERE processing IN ('sent', 'seen', 'seen_multi', 'unconfirmed')` | proof fields, processing advances |
| `ArcSSE` | persistent stream | Arcade SSE | `proven_txs.processing`, audit |
| `CheckNoSends` | every `CheckNoSendPeriodHours` | `proven_txs WHERE processing='nosend'` | maybe processing advance |
| `Reorg` | event + 5 min sweep | `proven_txs WHERE processing='reorging'` | proof + processing |
| `CoinbaseMaturity` | on tip change | `outputs WHERE is_coinbase AND NOT spendable AND matures_at_height <= tip` | `outputs.spendable` |
| `Reaper` | hourly | `transactions WHERE lifecycle IN ('draft', 'queued') AND ... older than threshold` | `lifecycle = 'failed'` cascade |
| `UnFail` | ≤10 min | `proven_txs WHERE processing='unfail'` | per §11 |
| `Reconcile` | every 30 min | sliding window of outputs | `spendable` corrections, audit |
| `ProcessBroadcastReceipts` | every 5 min | late receipts via idempotency_key | processing advance, audit |
| `AuditPrune` | daily | aged audit rows | archive/delete |

All tasks acquire `monitor_lease` before running. Multiple worker processes coordinate via leases.

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

## 14. Atomicity & ordering

### 14.1 Required atomic units

Each is one DB transaction:

1. `createAction` body (insert `proven_txs`, insert `transactions`, allocate inputs, insert change outputs, audit).
2. `signAction` body (raw_tx write, lifecycle change, audit).
3. `processBroadcastResult` body (`proven_txs.processing` + cascade lifecycle to all `transactions` + cascade outputs.spendable for all + audit).
4. `internalizeAction` proof path (per §8.1).
5. `internalizeAction` no-proof path insert (per §8.2; broadcast is a separate async action).
6. Reorg invalidation per orphaned `proven_txs` row.
7. Reprove success.
8. Coinbase maturity flip (batched per task tick).
9. Unfail resolution.
10. Reconcile correction.

### 14.2 Write ordering inside a transaction

1. `chain_tip` read (or write, if TipTracker).
2. `proven_txs` insert/update.
3. `transactions` lifecycle cascade (multiple rows possible if multi-user).
4. `outputs` spent_by / spendable updates.
5. `tx_audit` inserts.

### 14.3 Isolation

Minimum READ COMMITTED + `row_version` optimistic locking. SQLite SERIALIZABLE by engine default.

---

## 15. Conformance tests

### 15.1 FSM coverage

For each legal transition listed in §4.2 and §4.4, a named test:
`T_PROC_<from>_to_<to>` (processing transitions on `proven_txs`)
`T_LIFE_<from>_to_<to>` (lifecycle transitions on `transactions`)

### 15.2 Processing pipeline

- `T_PROC_BROADCAST_01_queued_to_sending_to_sent_arc` — ARC happy path.
- `T_PROC_BROADCAST_02_sent_to_seen_arc` — ARC `SEEN_ON_NETWORK`.
- `T_PROC_BROADCAST_03_seen_to_seen_multi_arcade` — Arcade SSE pipeline.
- `T_PROC_BROADCAST_04_sent_to_unconfirmed_woc` — WoC has no SEEN; jumps from `sent` to `unconfirmed`.
- `T_PROC_BROADCAST_05_serviceError_returns_to_queued` — provider fails → `queued` (NOT stuck in `sending`).
- `T_PROC_BROADCAST_06_no_regression` — `seen` cannot regress to `sent` even if a stale poll reports earlier status.
- `T_PROC_BROADCAST_07_sse_event_mapping` — every ARC/Arcade event string maps to the right `processing` value.

### 15.3 Multi-user dedupe

- `T_MULTIUSER_01_shared_proven_tx` — two users internalize the same txid; only one `proven_txs` row exists; both `transactions` rows reference it.
- `T_MULTIUSER_02_cascade_lifecycle` — proof arrives; both users' `transactions.lifecycle` advances to `confirmed` in one DB tx.
- `T_MULTIUSER_03_cascade_spendable` — outputs of both users flip `spendable` together.
- `T_MULTIUSER_04_reorg_cascade` — reorg invalidates one `proven_txs`; both users see `lifecycle='pending'`.

### 15.4 Schema

- `T_SCHEMA_01_columns_match` — both implementations report identical schema.
- `T_SCHEMA_02_indexes_match`.
- `T_SCHEMA_03_ts_writes_go_reads`.
- `T_SCHEMA_04_go_writes_ts_reads`.
- `T_SCHEMA_05_no_legacy_tables` (`proven_tx_reqs`, `known_txs`, `user_utxos` absent).
- `T_SCHEMA_06_proven_txs_dedupe` — same txid never appears twice in `proven_txs`.

### 15.5 Coupled-pair invariant

- `T_COUPLING_01_no_illegal_pair` — fuzz over all `(lifecycle, processing)` cross-products; only §4.4 pairs accepted.

### 15.6 Broadcast aggregation

- `T_AGG_01_success_wins_over_doubleSpend` — mixed result resolves to success.
- `T_AGG_02_invalid_only_after_all_fail`.
- `T_AGG_03_serviceError_never_marks_invalid`.
- `T_AGG_04_idempotency_key_reused` — retries carry same key.
- `T_AGG_05_sequential_only` — no parallel `.All` broadcast.

### 15.7 Coinbase

- `T_COINBASE_01_detected_at_index_zero`.
- `T_COINBASE_02_matures_at_height_set`.
- `T_COINBASE_03_unspendable_before_maturity`.
- `T_COINBASE_04_spendable_at_exact_maturity`.
- `T_COINBASE_05_reorg_lost_freezes` — `(frozen, reorging)` reached.
- `T_COINBASE_06_listOutputs_filters_immature`.

### 15.8 Reorg

- `T_REORG_01_proven_to_reorging`.
- `T_REORG_02_reorging_to_unconfirmed_on_reprove`.
- `T_REORG_03_outputs_preserved_through_reorg` (for non-coinbase).
- `T_REORG_04_never_invalid_non_coinbase`.

### 15.9 Output cache integrity

- `T_OUTPUT_01_failed_outputs_unspendable`.
- `T_OUTPUT_02_inputs_restored_on_failure`.
- `T_OUTPUT_03_reconcile_detects_drift`.
- `T_OUTPUT_04_no_side_index_read`.

### 15.10 Concurrency

- `T_CONC_01_lease_exclusivity`.
- `T_CONC_02_lease_expires_on_crash`.
- `T_CONC_03_row_version_conflict_retry`.

### 15.11 Audit

- `T_AUDIT_01_every_transition_logged`.
- `T_AUDIT_02_canonical_what_tags`.
- `T_AUDIT_03_provider_status_preserved` — `last_provider_status` and `tx_audit.details_json` contain the raw provider strings.

### 15.12 Cross-runtime soak

- `T_SOAK_01_alternating_runtimes` — TS and Go alternately run a workload on shared SQLite; final state from both matches.

---

## 16. Migration plan

### 16.1 Shared migration script

```sql
-- 1. New columns on proven_txs (which may not exist yet in TS — it does, but Go has known_txs instead)

-- For TS starting state:
ALTER TABLE proven_txs
  ADD COLUMN processing VARCHAR(20),
  ADD COLUMN processing_changed_at DATETIME,
  ADD COLUMN next_action_at DATETIME,
  ADD COLUMN attempts INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN rebroadcast_cycles INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN was_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN idempotency_key VARCHAR(64),
  ADD COLUMN batch VARCHAR(64),
  ADD COLUMN input_beef BLOB,
  ADD COLUMN is_coinbase BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN last_provider VARCHAR(40),
  ADD COLUMN last_provider_status VARCHAR(40),
  ADD COLUMN row_version BIGINT NOT NULL DEFAULT 0;

-- Migrate proven_tx_reqs data into proven_txs:
UPDATE proven_txs pt
  SET processing = CASE r.status
    WHEN 'unsent'      THEN 'queued'
    WHEN 'unprocessed' THEN 'queued'
    WHEN 'nosend'      THEN 'nosend'
    WHEN 'nonfinal'    THEN 'nonfinal'
    WHEN 'sending'     THEN 'queued'    -- restart any in-flight at boundary
    WHEN 'unmined'     THEN 'sent'
    WHEN 'callback'    THEN 'sent'
    WHEN 'unconfirmed' THEN 'unconfirmed'
    WHEN 'completed'   THEN 'proven'
    WHEN 'invalid'     THEN 'invalid'
    WHEN 'doubleSpend' THEN 'doubleSpend'
    WHEN 'unfail'      THEN 'unfail'
    ELSE                    'queued'
  END,
  attempts = r.attempts,
  was_broadcast = r.wasBroadcast,
  rebroadcast_cycles = r.rebroadcastAttempts,
  batch = r.batch,
  input_beef = r.inputBEEF,
  idempotency_key = COALESCE(r.batch, hex(randomblob(16)))   -- backfill keys
FROM proven_tx_reqs r
WHERE pt.txid = r.txid;

-- For txids that exist in proven_tx_reqs but NOT proven_txs (pre-proof), insert:
INSERT INTO proven_txs (txid, processing, attempts, was_broadcast, rebroadcast_cycles, raw_tx, input_beef, idempotency_key, ...)
SELECT r.txid, mapped_status, r.attempts, r.wasBroadcast, r.rebroadcastAttempts, r.rawTx, r.inputBEEF, ..., ...
FROM proven_tx_reqs r
LEFT JOIN proven_txs pt ON pt.txid = r.txid
WHERE pt.txid IS NULL;

-- For Go starting state:
-- Migrate known_txs columns into proven_txs (similar UPDATE/INSERT pattern).
-- Drop user_utxos; recompute outputs.spendable via §6.1.

-- 2. Update transactions table

ALTER TABLE transactions
  ADD COLUMN lifecycle VARCHAR(20),
  ADD COLUMN lifecycle_changed_at DATETIME,
  ADD COLUMN notify_json LONGTEXT NOT NULL DEFAULT '{}',
  ADD COLUMN row_version BIGINT NOT NULL DEFAULT 0;

UPDATE transactions SET lifecycle = CASE status
  WHEN 'unsigned'    THEN 'draft'
  WHEN 'unprocessed' THEN 'queued'
  WHEN 'nosend'      THEN 'nosend'
  WHEN 'nonfinal'    THEN 'nonfinal'
  WHEN 'sending'     THEN 'pending'
  WHEN 'unproven'    THEN 'pending'
  WHEN 'completed'   THEN 'confirmed'
  WHEN 'failed'      THEN 'failed'
  WHEN 'unfail'      THEN 'pending'
END;

ALTER TABLE transactions DROP COLUMN status;
ALTER TABLE transactions DROP COLUMN attempts;   -- if present from earlier migrations
-- raw_tx, input_beef move to proven_txs (already there in TS; Go too via known_txs merge)
ALTER TABLE transactions DROP COLUMN raw_tx;
ALTER TABLE transactions DROP COLUMN input_beef;

-- 3. New tables
CREATE TABLE chain_tip (id INT PRIMARY KEY, height INT UNSIGNED, block_hash VARCHAR(64), merkle_root VARCHAR(64), observed_at DATETIME, row_version BIGINT DEFAULT 0);
INSERT INTO chain_tip (id) VALUES (1);

CREATE TABLE tx_audit (...);                  -- per §3.5
CREATE TABLE monitor_lease (...);              -- per §3.6

-- 4. Migrate proven_tx_reqs.history (TS) / tx_notes (Go) into tx_audit
-- (one row per parsed history entry)

-- 5. Outputs columns
ALTER TABLE outputs
  ADD COLUMN is_coinbase BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN matures_at_height INT UNSIGNED,
  ADD COLUMN row_version BIGINT NOT NULL DEFAULT 0;

UPDATE outputs o
  SET o.is_coinbase = TRUE,
      o.matures_at_height = pt.height + 100
FROM proven_txs pt
JOIN transactions t ON t.provenTxId = pt.provenTxId
WHERE pt.merkle_index = 0 AND o.transactionId = t.transactionId;

-- 6. Re-derive outputs.spendable
UPDATE outputs SET spendable = ( ... §6.1 ... );

-- 7. Drop legacy tables
DROP TABLE proven_tx_reqs;   -- TS only
DROP TABLE known_txs;         -- Go only
DROP TABLE user_utxos;        -- Go only

-- 8. Drop legacy columns
ALTER TABLE transactions DROP COLUMN status;        -- if not already done in step 2

-- 9. Add new indexes (per §3.x)
CREATE INDEX idx_proven_txs_processing_next ON proven_txs (processing, next_action_at);
CREATE INDEX idx_proven_txs_block_hash ON proven_txs (block_hash);
CREATE INDEX idx_transactions_user_lifecycle ON transactions (userId, lifecycle, transactionId);
CREATE INDEX idx_transactions_proven_tx ON transactions (provenTxId);
CREATE INDEX idx_outputs_user_spendable_basket ON outputs (userId, spendable, basketId, satoshis);
CREATE INDEX idx_outputs_spent_by ON outputs (spent_by);
CREATE INDEX idx_outputs_coinbase_maturity ON outputs (matures_at_height) WHERE is_coinbase AND NOT spendable;
-- ...

-- 10. CHECK constraints for coupling pairs (where dialect supports)
ALTER TABLE transactions ADD CONSTRAINT chk_lifecycle CHECK (lifecycle IN ('draft', 'queued', 'nosend', 'nonfinal', 'pending', 'confirmed', 'failed', 'frozen'));
ALTER TABLE proven_txs ADD CONSTRAINT chk_processing CHECK (processing IN ('queued', 'nosend', 'nonfinal', 'sending', 'sent', 'seen', 'seen_multi', 'unconfirmed', 'proven', 'reorging', 'invalid', 'doubleSpend', 'unfail'));
```

### 16.2 Rollout

1. Ship v4 schema migration as a one-shot. Both v3-era and v4-era code can run against it after migration. **No mixed-version reads/writes.**
2. Ship v4 application code in both runtimes simultaneously.
3. Run conformance suite (§15) green on both before promoting to production.

---

## 17. Out of scope

- Multi-tenant sharding across DBs (deferred).
- Wallet-to-wallet sync protocol changes.
- Hardware-wallet signing protocols.
- Per-output RBF beyond `sequence_number` semantics.

---

## 18. Glossary

| Term | Definition |
|---|---|
| **Arcade** | Next-generation BSV broadcaster: HTTPS + SSE event stream. Provides the richest `processing` granularity (`sent`, `seen`, `seen_multi`). |
| **ARC** | Current BSV broadcaster API. Provides up to `seen` via polling. |
| **BEEF** | BSV Extended Element Format (BRC-62). |
| **BUMP** | BSV Unified Merkle Path (BRC-74). |
| **chain_tip** | Wallet's view of the active chain head. |
| **coinbase** | First tx in a block; merkle leaf offset 0. |
| **idempotency_key** | Per-txid token reused across broadcast retries. |
| **lifecycle** | Per-user application-visible status on `transactions`. |
| **monitor_lease** | Cooperative worker-exclusivity row. |
| **processing** | Per-txid monitor-visible status on `proven_txs`. |
| **reorging** | Transient processing state after orphan detection. |
| **row_version** | Optimistic-locking counter. |
| **seen** | `SEEN_ON_NETWORK` — other miners have observed the tx. |
| **seen_multi** | `SEEN_MULTIPLE_NODES` — Arcade-only propagation confirmation. |
| **sent** | Broadcaster has accepted the tx and placed it in its pipeline. |
| **frozen** | Terminal-but-recoverable lifecycle (admin freeze or coinbase-lost). |

---

**End of PROD_REQ_V4.md.**
