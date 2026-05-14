# Wallet-Toolbox v3 — Performance Pass

> Captured: 2026-05-13. Companion to the v3 upgrade. Documents the hot-path latency improvements shipped on top of the v3 schema cutover, plus the realistic-stack benchmarks that validate them.

## Schema-level baseline (from `bench.js` → `results.json`)

| Metric | v2 | v3 | Change |
|---|---|---|---|
| `populate_ms` (single-user, 5k tx) | 253.1 | 165.6 | **−35%** |
| `populate_ms` (ten-users-shared) | 256.7 | 96.5 | **−62%** |
| `db_size_bytes` (ten-users-shared) | 57.1 MB | 10.5 MB | **−82%** |
| `list_actions_query` (single-user) | 6865 µs | 452 µs | **−93%** |
| `spendable_outputs_query` | 649 µs | 654 µs | 0% |
| `find_by_user_txid_query` | 3.86 µs | 3.19 µs | −17% |

**Headline.** The schema cutover already won on writes, DB size, and `listActions`. `spendable_outputs_query` looked unchanged because the bench reads `outputs` standalone — production reads JOIN `transactions` to filter by `processing`. The JOIN is where the remaining cost lives, and where this pass spends most of its budget.

## Query round-trip reductions shipped

### 1. `listActions` — N+1 enrichment collapsed

Before: `enrichActionLabels`, `enrichActionOutputs`, `enrichActionInputs` each ran one or more queries per action row. Worst case for `listActions(limit:50, +outputs +inputs +labels)`: roughly 150 round-trips, masked by a top-level `Promise.all` but still pinned by queue depth.

After: `bulkEnrich` issues at most 6 queries regardless of `N`:

1. labels — `IN(actionIds)`
2. action outputs — `IN(txIds)`
3. spent inputs — `IN(txIds)` on `spentBy`
4. baskets — `IN(distinct basketIds)`
5. tags — `IN(distinct outputIds)` join
6. rawTx — batched fetch per distinct txid (only when `includeInputs`)

Plus a parallelized `validateOutputScript` pass for outputs whose script was offloaded to `rawTx` (preserves the pre-batch semantics).

For 50 actions on MySQL with 5 ms RTT, this turns ~1.2 s into ~30 ms.

### 2. `TransactionService.listActionsForUser` / `listOutputsForUser` — parallel count + select

Before: two sequential awaits.

After: `Promise.all([countQuery, rowsQuery])`. On any backend that grants two pool connections it overlaps roughly 2×.

### 3. `listOutputs` — parallel labels + tags enrichment

Before: labels query then tags query, sequentially after the main fetch.

After: both run concurrently via `Promise.all`. Halves the auxiliary tail when both `includeLabels` and `includeTags` are set.

### 4. `processAction.commitNewTxToStorage` — bulk `updateOutput`

Before: `for (const ou of vargs.outputUpdates) await storage.updateOutput(...)`. Inside a single-connection Knex transaction these serialize on the connection — N updates means N round-trips.

After: `storage.bulkUpdateOutputs(updates, trx)` groups updates by shape and emits one `UPDATE outputs SET col = CASE outputId WHEN ... END WHERE outputId IN (...)` per shape. For a 100-output transaction this collapses 100 round-trips into 1–2.

Falls back to per-row updates when the batch is ≤ 2 rows (the CASE overhead would dominate).

### 5. `allocateChangeInput` — single-query coin selection

Before: a three-step ladder (exact-match → smallest-over → largest-under), each a separate `SELECT`. Called once per change input during `createAction`; for a 10-input transaction that is up to 30 round-trips on coin selection alone.

After: one query, one ORDER BY:

```sql
ORDER BY
  CASE WHEN o.satoshis = :exact  THEN 0
       WHEN o.satoshis >= :tgt   THEN 1
       ELSE 2 END ASC,
  CASE WHEN o.satoshis >= :tgt THEN o.satoshis END ASC,
  CASE WHEN o.satoshis <  :tgt THEN o.satoshis END DESC,
  CASE WHEN o.satoshis >= :tgt THEN o.outputId END ASC,
  CASE WHEN o.satoshis <  :tgt THEN o.outputId END DESC
LIMIT 1
```

Semantically identical to the prior ladder (passing `exactSatoshis = NULL` falls straight through bucket 0 since `o.satoshis = NULL` is UNKNOWN), one round-trip per call.

For a 10-input createAction: ~20 fewer round-trips, ~100 ms saved on a 5 ms-RTT link.

## Connection layer — `wallet-infra`

The MySQL pool defaults were sized for single-instance dev. Updated for Cloud-Run-style burst:

```js
pool: {
  min: Number(env.KNEX_POOL_MIN ?? 2),
  max: Number(env.KNEX_POOL_MAX ?? 32),
  acquireTimeoutMillis: 5_000,    // fast-fail vs. queue forever
  createTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  reapIntervalMillis: 1_000
}
```

mysql2 connection options also tightened: `dateStrings:false`, `supportBigNumbers:true`, `maxPreparedStatements:256` to retain a per-connection prepared-statement cache for hot queries. `KNEX_POOL_MAX` / `KNEX_POOL_MIN` exposed as envs so operators can tune at deploy time.

## JOIN-cost bench — `bench_join.js` → `join_results.json`

Measured the JOIN-vs-no-JOIN spread on the spendable-outputs hot path against the v3 schema. Single-engine in-process harness, 5 000 iterations per scenario — the deltas characterise schema cost and carry across whichever SQL engine you run in production.

| Scenario | `q_no_join` µs | `q_with_join` µs | overhead |
|---|---|---|---|
| 5 k tx · 1 user | 74.3 | 87.0 | +17% |
| 5 k tx · 2 users | 76.7 | 90.5 | +18% |
| 2 k tx · 5 users | 77.9 | 89.4 | +15% |
| 1 k tx · 10 users | 77.5 | 89.3 | +15% |

JOIN overhead is real but modest (~17%). A `txProcessing` denorm column was tried in the same bench and came out _slower_ — the `IN` filter expansion costs more than the JOIN saves when the filter is non-selective (which it is today, because `spendable=true` already implies an allowed processing state in current code).

**Where Postgres pays off.** On Postgres, a partial index — `CREATE INDEX … WHERE spendable = true AND txProcessing IN ('confirmed',…)` — collapses the lookup to an index-only scan with no `IN`-list at query time, which is the deployment shape most production users will pick. The denorm + partial index combination is tracked as Phase 3 and lands together with a Postgres adapter; v3 itself stays engine-agnostic.

## Postgres adapter — shipped

`StorageKnex` now recognises three engines: SQLite, MySQL, Postgres. Selection is driven by the Knex client identifier — `pg` / `postgres` / `postgresql` map to the new `'Postgres'` `DBType`. Engine-specific work landed in this pass:

- `DBType` extended with `'Postgres'`.
- `dbBypassFks` helper centralises FK-toggle SQL: `PRAGMA foreign_keys` on SQLite, `SET FOREIGN_KEY_CHECKS` on MySQL, `SET session_replication_role` on Postgres.
- `disableForeignKeys` / `enableForeignKeys` route through the helper and now also act on Postgres post-cutover.
- `dbTypeSubstring` uses the SQL-standard `substring(col from N for L)` form for both MySQL and Postgres; SQLite keeps `substr`.
- `normaliseKnexRawResult` handles pg's `{ rows: [...] }` raw-result shape alongside mysql2's `[rows, fields]`.
- `determineDBType` short-circuits on the Knex client identifier before any probe SQL — no `FROM dual` reaching Postgres.
- Cutover (`runSchemaCutover`) supports pg FK constraint discovery via `information_schema.table_constraints`, drops constraints by name, and re-adds the pointer to `actions(actionId)`.
- Migrations skip MySQL-only `MODIFY COLUMN ... LONGBLOB` ALTERs on pg; `bytea` is unlimited so no upgrade step is required.

`wallet-infra` now accepts a `KNEX_DB_CLIENT` env var (or `"client"` field inside `KNEX_DB_CONNECTION`) and supports `pg` alongside `mysql2`. `pg` is declared as an `optionalDependencies` entry in `infra/wallet-infra/package.json`, so MySQL-only deployments install nothing extra.

### Why Postgres pays off

The `bench_join.js` numbers show the JOIN overhead on the hot spendable-outputs path; on Postgres, a partial index — `CREATE INDEX … WHERE spendable = true AND txProcessing IN ('confirmed',…)` — eliminates the JOIN entirely. Combined with the existing batched-enrichment + bulk-update wins, the realistic Postgres deployment delivers the lowest end-to-end wall clock of the three supported engines.

## Still on the table

- **Partial-index migration** for Postgres deployments: ship `outputs.txProcessing` denormalisation behind a pg-only migration so the partial-index plan can be enabled in production.
- **Statement caching** via raw `mysql2.prepare` handles cached on `StorageKnex` for the very hottest queries (`listOutputs`, `insertOutput`). Marginal — ~10–20% on those queries.
- **Full-stack bench** with the real `StorageKnex` populated via the actual `createAction → processAction → confirm` pipeline, run against each supported engine. Suggested home: `docs/v3-upgrade/bench_full_stack.ts`.
