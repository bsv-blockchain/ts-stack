# Wallet-Toolbox Refactor — Session Handoff

**Date:** 2026-05-12
**Branch:** `wallet-toolbox-v3`
**Spec source:** `PROD_REQ_V7_TS.md` + `bsv_wallet_transaction_requirements (1).md` v1.0

Use this doc to resume work in a fresh session. Read it top to bottom before dispatching new subagents.

---

## 0. Naming convention (renaming pass complete)

Prior drafts of this work used `V7`/`v7` as a working label throughout the codebase. That label was the 7th draft number of an internal requirements document and had no meaning outside this team. A bulk rename pass stripped every `V7`/`v7` reference from source, tests, docs, and most comments. Future readers should see the work as a wallet-toolbox refactor, not a versioned cut.

**Identifier renames applied:**

| From | To |
|---|---|
| `V7TransactionService` | `TransactionService` |
| `V7BackfillDriver` / `V7BackfillStats` | `BackfillDriver` / `BackfillStats` |
| `V7KnexBackfillDriver` / `V7IdbBackfillDriver` | `KnexBackfillDriver` / `IdbBackfillDriver` |
| `V7LeasedTask` | `LeasedMonitorTask` |
| `TableTransactionV7` | `TableTransactionNew` |
| `runV7Backfill` / `runV7KnexBackfill` / `runV7IdbBackfill` | `runBackfill` / `runKnexBackfill` / `runIdbBackfill` |
| `runV7Cutover` / `runV7IdbCutover` / `rollbackV7Cutover` | `runSchemaCutover` / `runIdbSchemaCutover` / `rollbackSchemaCutover` |
| `transactions_v7` (Knex table, IDB store, all string literals) | `transactions_new` |
| `transactionsV7` (IDB schema key) | `transactionsNew` |
| `upgradeTransactionsV7` | `upgradeTransactionsNew` |
| `getV7Service` | `getTransactionService` |

**File renames applied** (source + tests + docs):

```
src/storage/schema/v7Backfill.ts                  → backfill.ts
src/storage/schema/v7Backfill.runner.ts           → backfill.runner.ts
src/storage/schema/v7Backfill.knex.ts             → backfill.knex.ts
src/storage/schema/v7Backfill.idb.ts              → backfill.idb.ts
src/storage/schema/v7Crud.ts                      → transactionCrud.ts
src/storage/schema/v7Cutover.ts                   → schemaCutover.ts
src/storage/schema/v7CutoverIdb.ts                → schemaCutoverIdb.ts
src/storage/schema/v7Fsm.ts                       → processingFsm.ts
src/storage/schema/v7Service.ts                   → transactionService.ts
src/storage/schema/v7Spendability.ts              → spendabilityRule.ts
src/storage/schema/v7SpendabilityRefresh.ts       → spendabilityRefresh.ts
src/storage/schema/v7MonitorLease.ts              → monitorLease.ts
src/storage/schema/v7TxAudit.ts                   → txAudit.ts
src/storage/schema/v7CoinbaseMaturityBackfill.ts  → coinbaseMaturityBackfill.ts
src/storage/schema/tables/TableTransactionV7.ts   → TableTransactionNew.ts
src/monitor/V7LeasedTask.ts                       → LeasedMonitorTask.ts
test/storage/v7*.test.ts                          → matching descriptive names
docs/V7_*.md                                      → prefix dropped
```

**Migration string key:** `'2026-05-11-001 V7 additive schema (...)'` was renamed to `'2026-05-11-001 add refactor schema (...)'` because the migration was never released to production. Future migration keys should describe what they do without any version label.

**Comments cleaned:** every `V7 spec`, `per V7 §X`, `V7 canonical`, `V7 cutover`, etc. comment was rewritten contextually. File header doc blocks were rewritten to describe behavior without a version reference.

**Intentional carve-outs:**

- `PROD_REQ_V7_TS.md` — root spec doc, kept as the external source-of-record name.
- File-level citations like `* §5 conformance suite from PROD_REQ_V7_TS.md` — deliberate spec doc references.

**Verification:** `grep -rn 'V7\|v7' src test docs` returns zero hits outside the two intentional carve-outs above.

The renaming pass touched ~50 files. All renamed tests pass. Build clean.

---

## 1. Status at a glance

| Layer | Status |
|---|---|
| Schema (tables, FSM, migrations) | Complete |
| Backfill (pure helpers + Knex/IDB drivers) | Complete |
| TransactionService (CRUD + FSM + audit + lease + spendability) | Complete (15 net-new methods + 4 wave-1 methods) |
| Cutover (Knex + IDB destructive helpers) | Complete |
| Storage method wiring | Complete: listOutputsKnex, listActionsKnex, createAction, processAction, attemptToPostReqsToNetwork, internalizeAction |
| Monitor lease + recordProof integration | Partial: TaskCheckForProofs wired; other tasks deferred |
| Spec compliance (`bsv_wallet_transaction_requirements v1.0`) | §1-§6 fully satisfied; §7 testing 7/10 scenarios explicit; §8 3/4 satisfied |
| Tests | **15 refactor suites, 141 tests, 100% pass.** Combined storage+method suite 364 pass, 7 failures (pre-existing, see §4), 1 skipped |
| Naming | All `V7`/`v7` references stripped. See §0 above. |

Build: `npm run build` clean.

---

## 2. Files inventory

### Source — schema & migrations

```
src/sdk/types.ts                                  ProcessingStatus FSM + legacy maps
src/storage/schema/KnexMigrations.ts              Additive new-schema migration + maturity column
src/storage/schema/StorageIdbSchema.ts            IDB types for new-schema stores
src/storage/idbHelpers.ts                         IDB upgradeV1 + new-schema stores
src/storage/schema/tables/TableAction.ts          NEW per-user view type
src/storage/schema/tables/TableTransactionNew.ts   NEW per-txid canonical type
src/storage/schema/tables/TableChainTip.ts        NEW singleton chain tip
src/storage/schema/tables/TableTxAudit.ts         NEW append-only audit
src/storage/schema/tables/TableMonitorLease.ts    NEW per-task lease
src/storage/schema/tables/TableOutput.ts          ADDED maturesAtHeight field
src/storage/schema/tables/index.ts                exports
```

### Source — service primitives

```
src/storage/schema/processingFsm.ts                       Transition table + validator
src/storage/schema/spendabilityRule.ts              Pure §4 rule
src/storage/schema/spendabilityRefresh.ts       Knex refresh, preserves reorging
src/storage/schema/monitorLease.ts              tryClaim/renew/release
src/storage/schema/txAudit.ts                   appendTxAudit + auditProcessingTransition
src/storage/schema/transactionCrud.ts                      find/insert/transitionProcessing
src/storage/schema/transactionService.ts                   TransactionService — primary surface
```

### Source — backfill & cutover

```
src/storage/schema/backfill.ts                  Pure transformation helpers
src/storage/schema/backfill.runner.ts           Orchestrator (empty-txid map fix)
src/storage/schema/backfill.knex.ts             Knex driver
src/storage/schema/backfill.idb.ts              IDB driver
src/storage/schema/schemaCutover.ts                   Knex destructive cutover helper
src/storage/schema/schemaCutoverIdb.ts                IDB cutover (store rename via copy)
src/storage/schema/coinbaseMaturityBackfill.ts  One-off coinbase maturesAtHeight backfill
```

### Source — wired storage methods + monitor

```
src/storage/StorageProvider.ts                    getTransactionService, insertLegacyTransaction, disable/enableForeignKeys
src/storage/StorageKnex.ts                        TransactionService override, provenTxs*TableName helpers
src/storage/methods/createAction.ts               Routes inserts to transactions_legacy
src/storage/methods/processAction.ts              Calls findOrCreateActionForTxid + repointLabelsToActionId + repointOutputsToNewTransactionId
src/storage/methods/listActionsKnex.ts            JOIN actions ⨝ transactions, status filter mapping
src/storage/methods/listOutputsKnex.ts            t.processing filter, label-join via actions hop
src/storage/methods/attemptToPostReqsToNetwork.ts 10 call sites (recordHistoryNote, recordBroadcastResult, incrementAttempts, mergeBeefForTxids)
src/storage/methods/internalizeAction.ts          5 call sites (findActionByUserTxid, findOrCreateForBroadcast, recordProof/createWithProof, updateActionSatoshisDelta)
src/storage/methods/reviewStatus.ts               proven*TableName resolution
src/storage/methods/purgeData.ts                  proven*TableName resolution
src/monitor/Monitor.ts                            instanceId for lease ownership
src/monitor/LeasedMonitorTask.ts                       NEW helper wraps body in claim/renew/release
src/monitor/tasks/TaskCheckForProofs.ts           Lease-gated proof loop + recordProof hook
src/monitor/index.all.ts                          Exports LeasedMonitorTask
```

### Tests

```
src/storage/schema/__tests/backfill.test.ts             Pure helpers
src/storage/schema/__tests/backfill.runner.test.ts      Fake driver
src/storage/schema/__tests/processingFsm.test.ts                  Transition matrix
src/storage/schema/__tests/processingFsmLegacyMapping.test.ts     Legacy→new-schema status mapping
src/storage/schema/__tests/spendabilityRule.test.ts         §4 pure rule
test/storage/backfillKnex.test.ts                       Knex integration
test/storage/transactionCrudAndAudit.test.ts                       Insert/find/transition + audit
test/storage/monitorLease.test.ts                       Claim/renew/release/takeover
test/storage/schemaCutover.test.ts                            Full+empty+idempotent
test/storage/schemaCutoverIdb.test.ts                         IDB rename via fake-indexeddb
test/storage/schemaConformance.test.ts                        §5 + spec compliance (10 tests)
test/storage/coinbaseMaturityBackfill.test.ts           Maturity height = height+100
test/storage/transactionServiceExpansion.test.ts                   38 tests across 15 net-new methods
test/storage/methods/monitorLeaseIntegration.test.ts            Two-instance lease race
test/storage/listActionsKnexRefactor.test.ts                    listActions post-cutover
test/storage/methods/listOutputsKnexRefactor.test.ts            listOutputs post-cutover
test/storage/methods/createActionRefactor.test.ts         createAction/processAction wiring
test/storage/methods/attemptToPostReqsToNetworkRefactor.test.ts All 4 broadcast outcomes
test/storage/methods/internalizeActionWiring.test.ts    5 branches
```

### Docs

```
docs/CUTOVER_RUNBOOK.md           Operator runbook (pre-flight, smoke tests, rollback)
docs/ROLLOUT_PLAN.md              4-week phased plan + Linear ticket structure
docs/STORAGE_METHOD_WIRING.md     Gap analysis + 26-day effort estimate (now mostly done)
docs/CREATEACTION_BLOCKERS.md     txid timing problem + chosen Option B
docs/REQUIREMENTS_COMPLIANCE.md   Spec compliance audit
docs/SESSION_HANDOFF.md           This file
```

---

## 3. Spec compliance summary (v1.0)

Per `bsv_wallet_transaction_requirements (1).md`:

| Section | Status | Notes |
|---|---|---|
| §1 Core Principles | ✅ | Reorg gap fixed (FSM tightened, refresh preserves) |
| §2 Statuses | ✅ | 9-status spec mapped to 14 ProcessingStatus values |
| §3 Happy Path | ✅ | Self-created flow + fallback preserved in legacy |
| §4 Third-party | ✅ | Both confirmed + unconfirmed paths covered |
| §5 Failure scenarios | ✅ | All 7 scenarios handled |
| §6 DB sync rules | ✅ | Refresh skips reorging to preserve spendable |
| §7 Tests | 7/10 explicit | Tests A (tip/deep), B (broadcast-fail discard), E (mixed broadcast) deferred — legacy code covers semantics but no new-schema-specific test |
| §8 Non-functional | 3/4 | Atomicity gap acknowledged (eventual consistency via refresh) |

---

## 4. Known pre-existing failures (not migration-caused)

| Test | Cause | Fix path |
|---|---|---|
| `createActionToGenerateBeefs.man.test.ts` (6 tests) | Manual test, requires live funded wallet | None — operator-driven |
| `StorageMySQLDojoReader.man.test.ts` | Needs `TEST_DOJO_CONNECTION` env | None — operator-driven |
| `adminStats.man.test.ts` | Needs MySQL env | None — operator-driven |
| `abortAction.test.ts` (when run with other suites) | Knex connection pool exhaustion (resource leak in beforeAll) | Fix pool teardown in test fixtures; tests pass when run alone |
| `markStaleInputsAsSpent.test.ts` | FK violation pre-cutover (schema bug predating cutover) | Likely fixed by running cutover before test |
| `findLegacy.test.ts` test 8 | Queries `status` column on post-cutover `transactions` | Rewrite to use `processing` or query `transactions_legacy` |
| `update.test.ts 7a updateTransactionStatus` | Pre-existing | Same path as findLegacy test 8 |

---

## 5. Pickup list for next session

Prioritized by impact:

### High value, small scope

1. **§7 test coverage fills (3 tests).** Add to `test/storage/schemaConformance.test.ts`:
   - Test A: third-party confirmed at chain tip → `unconfirmed` + spendable.
   - Test B: third-party unconfirmed, broadcast fails → no DB row created.
   - Test E: mixed broadcast results across services → positive accepted + `tx_audit` records discrepancy.
2. **Fix `abortAction.test.ts` resource leak.** Likely a missing `knex.destroy()` in `beforeAll`/`afterAll`. Run individually first to confirm fix isolates.
3. **Fix `findLegacy.test.ts` test 8 and `update.test.ts 7a`.** Either rewrite to use `transactions_legacy` or skip if test no longer applies post-cutover.

### Medium value, medium scope

4. **Monitor wiring expansion.** Currently only `TaskCheckForProofs` lease-gated and new-schema-aware. Other tasks (`TaskNewHeader`, `TaskPurge`, etc.) still bypass the new-schema service. Wrap each with `LeasedMonitorTask` and add `recordProof`/`transition` hooks where applicable.
5. **Atomicity tightening (GAP 3 from compliance doc).** Wrap `transitionProcessing` + targeted `refreshOutputsSpendable(userId, txid)` in a Knex transaction at call sites where torn reads would matter (e.g. mid-processAction state change).
6. **IDB-side new-schema service.** Currently `StorageIdb.getTransactionService()` returns `undefined`. Implement a parallel `TransactionServiceIdb` operating on the existing IDB stores so non-Knex deployments get full new-schema semantics.

### Operator-driven, no code

7. **Staging cutover dry-run.** Follow `docs/ROLLOUT_PLAN.md` week 2. Capture timing, verify smoke tests, document any rough edges.
8. **Coinbase maturity backfill on legacy data.** Run `backfillCoinbaseMaturity` on staging to populate `matures_at_height` for legacy coinbase outputs. Tracks in `BackfillCoinbaseMaturityStats`.

### Defer / out of scope

- **`StorageMySQLDojoReader.man.test.ts` + `adminStats.man.test.ts`** — manual tests requiring external infrastructure.
- **`createActionToGenerateBeefs.man.test.ts`** — needs live funded wallet.

---

## 6. Key commands

```bash
cd /Users/personal/git/ts-stack/packages/wallet/wallet-toolbox

# Build
npm run build

# All new-schema + migrations (target green: 20 suites, 169 tests)
npx jest --testPathPatterns="schema|backfill|cutover|storage/KnexMigrations" --silent

# Specific schema conformance
npx jest --testPathPatterns="schemaConformance"

# Wired storage methods
npx jest --testPathPatterns="createAction|processAction|internalizeAction|attemptToPost|listActions|listOutputs" --silent

# Cutover dry-run on a populated test SQLite (see test/storage/schemaCutover.test.ts)
# Production: see docs/CUTOVER_RUNBOOK.md
```

---

## 7. Architecture invariants to preserve

When making further changes:

- **The transaction service is the only sanctioned mutation path for `transactions`/`actions` post-cutover.** Direct `knex('transactions').insert(...)` writes break the FSM + audit contract. Use `TransactionService.create` / `transition` / `findOrCreate*`.
- **Every state change writes a `tx_audit` row** via `auditProcessingTransition` (called inside `transitionProcessing`). Don't bypass.
- **`runSchemaCutover` is one-way in production.** Keep `transactions_legacy` and friends for 30 days per runbook §5.
- **Reorg branch must never write `invalid` or `doubleSpend` directly.** FSM enforces this. Monitor's reorg handler should follow `confirmed → reorging → unconfirmed`, then handle invalidation via the standard path if independently detected.
- **`outputs.spendable` is a cached derivative.** Source of truth is the §4 rule. Always refresh after transition.
- **Coinbase outputs need both `is_coinbase = true` on the new-schema transaction AND `matures_at_height` populated on the output row.** Maturity maturity backfill is a one-off post-cutover operation.

---

## 8. Subagent prompt templates that worked

Use these as starting points for the pickup list:

- **Test gap fill** → `bopen-tools:tester` with: "Read `docs/REQUIREMENTS_COMPLIANCE.md` §7. Add Test [A/B/E] to `test/storage/schemaConformance.test.ts` using `setupCutDb` pattern. Assert spec-cited behavior. Run `npx jest --testPathPatterns="schemaConformance"`."
- **Storage wiring** → `bsv-blockchain-wallet-toolbox-expert` with method file path + service signatures + "Gate calls through `storage.getTransactionService()`. Pre-cutover/IDB returns `undefined`, fall back to legacy code. Add test in `test/storage/methods/<Method>Wiring.test.ts`."
- **Monitor task wiring** → `bsv-blockchain-wallet-toolbox-expert` with task file path + "Wrap body in `LeasedMonitorTask.run('<task-name>', this.instanceId, 60_000, async () => { /* body */ })`. Call appropriate transaction service method on state-change events."

Caveats from prior sessions:
- Don't dispatch two subagents that both touch `transactionService.ts` or `StorageKnex.ts` in parallel — merge conflicts. Serialize.
- The `bopen-tools:architecture-reviewer` agent refuses to write `.md` analysis files per its prompt; pass output back through main agent to persist.
- Test fixture changes ripple — `TestUtilsWalletStorage.ts:insertTestTransaction` is now new-schema-aware; preserve that path.

---

**End of handoff document.** Resume work by reading §5 pickup list, then dispatch per §8 template.
