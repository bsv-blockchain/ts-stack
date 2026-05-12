# BSV Wallet Transaction Confirmation & UTXO Management Requirements

**Document Purpose**  
This requirements specification defines the rules for determining when a transaction is confirmed on the BSV Blockchain, how the wallet software must track broadcast status, and how changes to transaction status must be reflected in the separate outputs (UTXO) table.  

The goal is to improve the software that manages UTXOs and broadcast status on behalf of users by providing clear, testable criteria for validation. All new transactions — whether created internally via `createAction` or received from third parties via `internalizeAction` — must be handled according to these rules.

**Version:** 1.0  
**Date:** May 2026  

---

## 1. Core Principles

- A transaction is **confirmed on-chain** only when it has a valid Merkle path **and** at least one additional block has been mined on top of the block containing it (i.e., the transaction's block is no longer the chain tip).
- The outputs table is the single source of truth for spendability. Transaction status changes must **always** trigger the correct update to the `spendable` flag on related outputs.
- Invalid or double-spent outputs are **toxic** — they must never be selected as inputs for future transactions.
- The system must be **robust** for self-created transactions and **strict** for third-party transactions.
- Reorganizations are a normal part of blockchain operation and **extremely rarely** cause a previously valid transaction to be marked invalid.

---

## 2. Transaction Statuses (Requirements)

The wallet SHALL support the following statuses for the main transactions table:

| Status       | Description                                                                 | spendable on Outputs |
|--------------|-----------------------------------------------------------------------------|----------------------|
| **nosend**   | Draft transaction (unsigned or incomplete). Not yet ready for broadcast.   | `false`             |
| **sending**  | Broadcast request initiated or in progress.                                | `false`             |
| **unmined**  | Broadcast accepted by service; transaction seen on network but not yet mined. | `true`              |
| **callback** | Awaiting callback / Server-Sent Event (SSE) from broadcast service.        | `true`              |
| **unconfirmed** | Mined into a block with valid Merkle path, but block is still the chain tip (0 confirmations beyond tip). | `true` (normal) / `false` (Coinbase) |
| **completed** | Confirmed on-chain: valid Merkle path + at least 1 block built on top.     | `true` (normal) / `false` (Coinbase) |
| **invalid**  | Rejected by broadcast service(s) or structurally invalid.                  | `false`             |
| **doubleSpend** | Inputs have been spent by a conflicting transaction that was mined first. | `false`             |
| **unfail**   | Admin-initiated retry after previous failure (does not alter output state). | No change           |

**Note on Coinbase outputs:** Detected when the transaction offset in the Merkle path is 0. These outputs SHALL remain non-spendable until the transaction reaches **100 confirmations** (100 blocks deep), even if status reaches Completed earlier.

---

## 3. Happy Path — Self-Created Transactions (`createAction`)

The software SHALL enforce the following progression for transactions the wallet creates:

1. **nosend** → User/application finalizes the transaction.
2. **sending** → Broadcast request sent to primary service (ARC / Arcade preferred).
3. **unmined** → Positive response received from broadcast service.
4. **callback** → Awaiting mined event via webhook or SSE.
5. **unconfirmed** → First "mined" event + Merkle path received.
6. **completed** → One additional block mined on top (Merkle path now considered stable).

**Broadcast Robustness Requirements:**
- Primary service: ARC / Arcade.
- On 404, 500, timeout, or indefinite hang: automatically fall back to secondary services (WhatsOnChain, BitTails) **sequentially** — never broadcast to multiple services simultaneously.
- Mixed results (one service accepts, another rejects) SHALL be resolved by trusting the positive response but logging the discrepancy. The transaction SHALL NOT be marked Invalid unless **all** attempted services reject it.
- The `Unfail` status MAY be used for manual/admin retry without changing output spendability.

---

## 4. Third-Party Transactions (`internalizeAction`)

### 4.1 Already-Confirmed Incoming Transactions (Merkle path provided)

- Validate Merkle path against local chain tracks service (Merkle root must match block header chain).
- If validation succeeds:
  - Block is **below current tip** (≥1 block deep) → Status = **Completed**, `spendable = true` (unless Coinbase maturity rule applies).
  - Block is **current tip** (just mined) → Status = **Unconfirmed**, `spendable = true` (unless Coinbase).
- If Merkle path validation fails → **discard** the transaction (do not persist).

### 4.2 Unconfirmed Incoming Transactions

- Start at **Sending** status.
- Broadcast the transaction ourselves (to register callbacks/SSE).
- If broadcast succeeds → follow normal happy-path flow.
- If broadcast returns **Invalid** or fails → **completely discard** the transaction. Do **not** store it in the database. (Application layer may retain a fraud-detection record if desired.)

---

## 5. Failure Scenarios & Required Handling

The software SHALL explicitly detect, log, and handle the following cases:

| Failure Scenario                        | Self-Created (`createAction`)                          | Third-Party (`internalizeAction`)                     | Effect on Outputs                  |
|-----------------------------------------|-------------------------------------------------------|-------------------------------------------------------|------------------------------------|
| Broadcast service error (404/500/timeout/hang) | Try next service sequentially                        | Discard immediately                                   | No change (or remain non-spendable) |
| Mixed broadcast results                 | Prefer positive response; log discrepancy            | N/A (strict mode)                                     | Follow positive path               |
| Rejected as invalid by broadcaster      | Mark **Invalid** only after all services fail        | **Discard completely**                                | `spendable = false`                |
| Never mined (stuck in mempool)          | Remain in Unmined/Callback; support manual Unfail    | Discard                                               | `spendable = false` if discarded   |
| Double-spend (conflicting tx mined)     | Set status = **DoubleSpend**                         | Set status = **DoubleSpend** (if already stored)      | `spendable = false` (toxic)        |
| Blockchain reorg (block orphaned)       | Revert to **Unconfirmed**; do **not** mark Invalid   | Revert to **Unconfirmed**; do **not** mark Invalid   | Keep previous spendable value      |
| Coinbase output (offset 0 in Merkle)    | Enforce 100-block maturity rule                      | Enforce 100-block maturity rule                      | `spendable = false` until 100 deep |

**Reorg Rule (Critical):**  
A reorg affects only the Merkle path and block position. It SHALL **never** cause a transaction to be marked Invalid or DoubleSpend. The status SHALL be reverted to Unconfirmed (or Unmined if appropriate), and the wallet must wait again for a new confirmation + 1 block before returning to Completed.

---

## 6. Database Synchronization Rules (Transaction ↔ Outputs)

Whenever a transaction status changes, the software **SHALL** update the related outputs in the separate outputs table as follows:

- **Status → Unmined / Callback / Unconfirmed / Completed** (normal outputs):  
  Set `spendable = true`, clear any previous `spentBy` if applicable.

- **Status → Invalid or DoubleSpend**:  
  Set `spendable = false` on **all** outputs of the transaction.  
  These outputs become **toxic** and MUST be excluded from all future input-selection logic.

- **Status → Unfail**:  
  Do **not** modify the outputs table. This is an admin retry only.

- **Reorg**:  
  Revert transaction status; **preserve** the current `spendable` value of outputs (do not flip to false).

- **Coinbase outputs**:  
  Ignore the above until block depth ≥ 100. `spendable` must remain `false` regardless of transaction status.

- **Incoming confirmed tx**:  
  Create or update output records with correct `spendable` flag at the moment the transaction record is persisted.

---

## 7. Validation & Testing Criteria

To validate the software against these requirements, the following scenarios **MUST** pass:

1. Happy-path self-created transaction reaches Completed with outputs spendable.
2. Third-party confirmed transaction (deep block) is accepted as Completed with spendable outputs.
3. Third-party confirmed transaction (tip block) is accepted as Unconfirmed with spendable outputs.
4. Third-party unconfirmed transaction that fails broadcast is discarded (no DB record).
5. Broadcast service failure triggers automatic fallback for self-created tx only.
6. Invalid or DoubleSpend status immediately sets all related outputs to `spendable = false`.
7. Reorg of a Completed transaction reverts it to Unconfirmed without invalidating outputs.
8. Coinbase output remains non-spendable until exactly 100 blocks deep.
9. Unfail status changes transaction state but leaves outputs untouched.
10. Mixed broadcast results are handled gracefully without data corruption between tables.

---

## 8. Non-Functional Requirements

- All status transitions and output updates MUST be atomic (transaction + outputs updated together or rolled back).
- The system SHALL log every status change with timestamp and reason for auditability.
- Performance: Status updates and output spendability checks SHALL complete in < 100 ms under normal load.
- The wallet SHALL remain functional even if the primary broadcast service (ARC) is unavailable.

---

**End of Requirements Document**

This specification provides a complete, unambiguous baseline for implementing and validating the UTXO and broadcast-status management logic in the BSV wallet. All future development and testing should be measured against these rules to ensure users' funds remain safe and correctly spendable.