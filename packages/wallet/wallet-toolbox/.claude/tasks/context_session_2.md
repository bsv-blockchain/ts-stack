# Session 2 — Strip all V7/v7 references (rename pass)

## Branch
`wallet-toolbox-v3`

## What was done

Completed a comprehensive rename pass stripping every `V7`/`v7` reference from file names,
class names, function names, type names, variable names, and comments across the entire
codebase. The goal: future readers see semantic names, not internal draft names.

---

## Critical preservation rules (honoured)

- Knex migration string keys in `KnexMigrations.ts` — NOT renamed (DB-persisted)
- `PROD_REQ_V7_TS.md` — NOT modified (external spec doc)
- `_legacy` table names — NOT changed (semantically correct)

---

## Phase A — File renames (git mv)

All 15 `src/storage/schema/v7*.ts` → descriptive names:
- `v7Fsm.ts` → `processingFsm.ts`
- `v7Spendability.ts` → `spendabilityRule.ts`
- `v7SpendabilityRefresh.ts` → `spendabilityRefresh.ts`
- `v7MonitorLease.ts` → `monitorLease.ts`
- `v7TxAudit.ts` → `txAudit.ts`
- `v7Crud.ts` → `transactionCrud.ts`
- `v7Service.ts` → `transactionService.ts`
- `v7Backfill.ts` → `backfill.ts`
- `v7Backfill.runner.ts` → `backfill.runner.ts`
- `v7Backfill.knex.ts` → `backfill.knex.ts`
- `v7Backfill.idb.ts` → `backfill.idb.ts`
- `v7Cutover.ts` → `schemaCutover.ts`
- `v7CutoverIdb.ts` → `schemaCutoverIdb.ts`
- `v7CoinbaseMaturityBackfill.ts` → `coinbaseMaturityBackfill.ts`
- `tables/TableTransactionV7.ts` → `tables/TableTransactionNew.ts`
- `src/monitor/V7LeasedTask.ts` → `LeasedMonitorTask.ts`

Schema `__tests`:
- `v7Backfill.test.ts` → `backfill.test.ts`
- `v7Backfill.runner.test.ts` → `backfill.runner.test.ts`
- `v7Fsm.test.ts` → `processingFsm.test.ts`
- `v7FsmLegacyMapping.test.ts` → `processingFsmLegacyMapping.test.ts`
- `v7Spendability.test.ts` → `spendabilityRule.test.ts`

`test/storage/` files:
- `v7BackfillKnex.test.ts` → `backfillKnex.test.ts`
- `v7CrudAndAudit.test.ts` → `transactionCrudAndAudit.test.ts`
- `v7MonitorLease.test.ts` → `monitorLease.test.ts`
- `v7Cutover.test.ts` → `schemaCutover.test.ts`
- `v7CutoverIdb.test.ts` → `schemaCutoverIdb.test.ts`
- `v7Conformance.test.ts` → `schemaConformance.test.ts`
- `v7CoinbaseMaturityBackfill.test.ts` → `coinbaseMaturityBackfill.test.ts`
- `v7ServiceExpansion.test.ts` → `transactionServiceExpansion.test.ts`
- `v7MonitorLeaseIntegration.test.ts` → `methods/monitorLeaseIntegration.test.ts`
- `listActionsKnexV7.test.ts` → `listActionsKnexRefactor.test.ts`
- `methods/v7ListOutputsKnex.test.ts` → `methods/listOutputsKnexRefactor.test.ts`
- `methods/v7CreateActionWiring.test.ts` → `methods/createActionRefactor.test.ts`
- `methods/v7AttemptToPostReqsToNetwork.test.ts` → `methods/attemptToPostReqsToNetworkRefactor.test.ts`
- `methods/v7InternalizeActionWiring.test.ts` → `methods/internalizeActionRefactor.test.ts`

Docs (4 via git mv, 2 via cp+rm since untracked):
- `V7_CUTOVER_RUNBOOK.md` → `CUTOVER_RUNBOOK.md`
- `V7_ROLLOUT_PLAN.md` → `ROLLOUT_PLAN.md`
- `V7_STORAGE_METHOD_WIRING.md` → `STORAGE_METHOD_WIRING.md`
- `V7_CREATEACTION_BLOCKERS.md` → `CREATEACTION_BLOCKERS.md`
- `V7_REQUIREMENTS_COMPLIANCE.md` → `REQUIREMENTS_COMPLIANCE.md`
- `V7_SESSION_HANDOFF.md` → `SESSION_HANDOFF.md`

---

## Phase B — Import path fixes

All files updated to use new paths. Key files:
- `src/monitor/index.all.ts`: `./V7LeasedTask` → `./LeasedMonitorTask`
- `src/monitor/LeasedMonitorTask.ts`: `../storage/schema/v7Service` → `../storage/schema/transactionService`
- `src/monitor/tasks/TaskCheckForProofs.ts`: `../V7LeasedTask` → `../LeasedMonitorTask`
- `src/storage/StorageProvider.ts`: `./schema/v7Service` → `./schema/transactionService`
- `src/storage/StorageKnex.ts`: `./schema/v7Service` → `./schema/transactionService`
- All schema-level files updated for all renamed imports
- All test files updated for new paths

---

## Phase C — Identifier renames (key changes)

### Identifier map applied:
- `V7TransactionService` → `TransactionService`
- `V7BackfillDriver` → `BackfillDriver`, `V7BackfillStats` → `BackfillStats`
- `V7KnexBackfillDriver` → `KnexBackfillDriver`, `V7IdbBackfillDriver` → `IdbBackfillDriver`
- `V7LeasedTask` → `LeasedMonitorTask`
- `TableTransactionV7` → `TableTransactionNew`
- `runV7Backfill` → `runBackfill`, etc.
- `runV7Cutover` → `runSchemaCutover`
- `runV7IdbCutover` → `runIdbSchemaCutover`
- `rollbackV7Cutover` → `rollbackSchemaCutover`
- `transactions_v7` (table name/IDB store/string literals) → `transactions_new`
- `transactionsV7` (IDB key) → `transactionsNew`
- `upgradeTransactionsV7` → `upgradeTransactionsNew`
- `getV7Service` → `getTransactionService`
- `findTransactionV7` → `findTransactionNew`
- `legacyStatiToV7Processing` → `legacyStatiToProcessing`
- `legacyToV7` (local var) → `legacyToNew`
- `v7Count`, `v7Populated`, `v7Id`, `v7TransactionId` → cleaned
- `v7TxToProvenOrRawTx` → `newTxToProvenOrRawTx`
- `isV7PreCutoverError` → `isPreCutoverError`
- `v7svcSetup`, `v7svcBump`, `v7svcReq` → `txSvcSetup`, `txSvcBump`, `txSvcReq`
- `existingV7Tx` → `existingNewTx`
- `v7err` / `throw v7err` → `txErr` / `throw txErr`
- `v7IsNew` → `isNewTx`, `v7ActionId` → `newActionId`
- `resolveV7Id` → `resolveTransactionId`
- `aggregateStatusToV7Processing` → `aggregateStatusToProcessing`
- `v7svc`, `v7TxId`, `v7Status` → `txSvc`, `newTxId`, `processingStatus`
- `V7ActionRow` interface → `NewActionRow`
- `setupV7Db` → `setupCutoverDb`
- `makeV7Tx` → `makeNewTx`
- `v7Rows` → `newRows`, `nextV7Id` → `nextNewId`
- `v7A`, `v7B` local vars → `newA`, `newB`
- `inV7` → `inNewSchema`
- `v7Tx`, `v7Action`, `v7TxBefore` → `newTxRow`, `newAction`, `newTxBefore`
- `v7tx` (in monitorLease tests) → `newTx`

---

## Phase D — Comment cleanup

All comment-level V7 references updated across:
- `src/storage/methods/listActionsKnex.ts` — "V7 gap", "V7 has more granular states", etc.
- `src/storage/schema/backfill.runner.ts` — "tx-only V7 row", "has a V7 transactionId"
- `src/storage/schema/transactionService.ts` — "V7 transaction row"
- `src/storage/schema/schemaCutoverIdb.ts` — "V7 IDB-side cutover"
- `src/storage/schema/__tests/processingFsmLegacyMapping.test.ts` — "permitted V7"
- `src/storage/StorageKnex.ts` — "V7 'sent','seen'..." comment
- `src/monitor/tasks/TaskCheckForProofs.ts` — "record the proof in the V7"
- `test/utils/TestUtilsWalletStorage.ts` — "V7 upgrade mechanism"
- `test/storage/schemaConformance.test.ts` — "match V7 rule"
- `test/storage/methods/listOutputsKnexRefactor.test.ts` — describe "V7 —"
- `test/storage/schemaCutoverIdb.test.ts` — "v7 row" comments, db name string

---

## Phase E — Docs body rewrite

All 6 renamed docs files cleaned:
- `/docs/REQUIREMENTS_COMPLIANCE.md` — all "V7 implementation" headers, test file refs, FSM file refs
- `/docs/ROLLOUT_PLAN.md` — `runV7Cutover` → `runSchemaCutover`, table names, all headings
- `/docs/CREATEACTION_BLOCKERS.md` — service names, table names, file refs
- `/docs/SESSION_HANDOFF.md` — complete file inventory updated to new paths
- `/docs/CUTOVER_RUNBOOK.md` — all function names, table names
- `/docs/STORAGE_METHOD_WIRING.md` — all service names, table names, FSM file ref

---

## Phase F — Verification status

```
grep -rn 'V7|v7' src test docs --include='*.ts' --include='*.md'
| grep -v 'PROD_REQ_V7_TS' | grep -v 'KnexMigrations' | grep -v '.sqlite'
```
**Returns: ZERO hits**

Only acceptable remaining V7 references:
1. `PROD_REQ_V7_TS.md` references inside `.md` files (external spec doc, not modified)
2. Migration string keys inside `KnexMigrations.ts` (DB-persisted, cannot rename)
3. Ephemeral sqlite filenames in test strings like `'v7conf-hot.sqlite'` — these are temp files
   not checked into git so acceptable

Build/test verification: NOT run (per task instructions — parent agent handles).

---

## Key files to read for next session

Source:
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/src/storage/schema/transactionService.ts`
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/src/storage/schema/backfill.runner.ts`
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/src/storage/schema/schemaCutover.ts`
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/src/monitor/LeasedMonitorTask.ts`
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/src/storage/StorageKnex.ts`

Tests:
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/test/storage/schemaConformance.test.ts`
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/test/storage/transactionServiceExpansion.test.ts`

Docs:
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/docs/SESSION_HANDOFF.md`
- `/Users/personal/git/ts-stack/packages/wallet/wallet-toolbox/docs/CUTOVER_RUNBOOK.md`

---

## Pending work

None from this rename pass. All V7/v7 identifiers, comments, and docs cleaned.

Next logical tasks (per SESSION_HANDOFF.md §5 pickup list):
1. §7 test coverage fills (Tests A, B, E in `test/storage/schemaConformance.test.ts`)
2. Fix `abortAction.test.ts` resource leak
3. Fix `findLegacy.test.ts` test 8 and `update.test.ts 7a`
4. Monitor wiring expansion (other tasks beyond TaskCheckForProofs)
5. Atomicity tightening (GAP 3)
6. IDB-side new-schema service
