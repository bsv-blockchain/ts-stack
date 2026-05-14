import { Knex } from 'knex'
import { transactionStatusToProcessing, TransactionStatus } from '../../sdk/types'
import { TransactionService } from './transactionService'

/**
 * Detect knex client (mysql / pg / sqlite). Mirrors the helper in
 * `schemaCutover.ts` to avoid a cross-file dep cycle.
 */
function knexClient (knex: Knex): 'mysql' | 'pg' | 'sqlite' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: string | undefined = (knex as any).client?.config?.client ?? (knex as any).client?.dialect
  if (c === 'mysql' || c === 'mysql2') return 'mysql'
  if (c === 'pg' || c === 'postgres' || c === 'postgresql' || c === 'pg-native' || c === 'pgnative') return 'pg'
  return 'sqlite'
}

/**
 * Post-cutover rebuild of `outputs.transactionId`, `outputs.spentBy`, and
 * `commissions.transactionId` foreign keys so they reference canonical
 * `transactions(transactionId)` instead of `transactions_legacy(transactionId)`.
 *
 * On MySQL and Postgres, RENAME TABLE updates FK references to follow the
 * renamed target. After `runSchemaCutover` renames `transactions` →
 * `transactions_legacy`, the FK from `outputs.transactionId` (and friends)
 * follows the rename and ends up pointing at `transactions_legacy` — which is
 * not where the canonical rows live. Subsequent writes that touch
 * `outputs.transactionId` with a canonical id fail FK enforcement.
 *
 * SQLite's `legacy_alter_table=ON` mode (used inside `runSchemaCutover`)
 * suppresses the rewrite — the FK stays bound to the bare string
 * `"transactions"` which resolves to the renamed-in canonical table.
 *
 * This helper is idempotent: it only acts when the FK's referenced table is
 * `transactions_legacy` and skips otherwise.
 */
async function rebuildLegacyFkTargets (knex: Knex): Promise<void> {
  const client = knexClient(knex)
  if (client === 'sqlite') return // FK name-bound — no rebuild needed.

  if (client === 'mysql') {
    const dbRow: any = (await knex.raw('SELECT DATABASE() AS d'))[0]
    const dbName = Array.isArray(dbRow) ? dbRow[0]?.d : dbRow?.d

    // Re-target FKs that currently reference transactions_legacy.
    const wrongRows: any = await knex('information_schema.KEY_COLUMN_USAGE')
      .where({ TABLE_SCHEMA: dbName, REFERENCED_TABLE_NAME: 'transactions_legacy' })
      .whereIn('TABLE_NAME', ['outputs', 'commissions'])
      .select('TABLE_NAME', 'CONSTRAINT_NAME', 'COLUMN_NAME')
    for (const row of wrongRows ?? []) {
      const table = row.TABLE_NAME ?? row.table_name
      const cname = row.CONSTRAINT_NAME ?? row.constraint_name
      const col = row.COLUMN_NAME ?? row.column_name
      if (table == null || cname == null || col == null) continue
      await knex.raw('ALTER TABLE `' + table + '` DROP FOREIGN KEY `' + cname + '`')
      await knex.raw(
        'ALTER TABLE `' + table + '` ADD CONSTRAINT `' + cname + '` ' +
        'FOREIGN KEY (`' + col + '`) REFERENCES `transactions`(`transactionId`)'
      )
    }

    // Add FKs that should exist but don't (e.g. dropped by a prior partial
    // recovery run). Check the canonical names produced by Knex's createTable
    // for each (table, column) pair.
    const wanted: Array<{ table: string, col: string, cname: string }> = [
      { table: 'outputs', col: 'transactionId', cname: 'outputs_transactionid_foreign' },
      { table: 'outputs', col: 'spentBy', cname: 'outputs_spentby_foreign' },
      { table: 'commissions', col: 'transactionId', cname: 'commissions_transactionid_foreign' }
    ]
    for (const w of wanted) {
      const existing: any = await knex('information_schema.KEY_COLUMN_USAGE')
        .where({ TABLE_SCHEMA: dbName, TABLE_NAME: w.table, COLUMN_NAME: w.col })
        .whereNotNull('REFERENCED_TABLE_NAME')
        .first()
      if (existing == null) {
        await knex.raw(
          'ALTER TABLE `' + w.table + '` ADD CONSTRAINT `' + w.cname + '` ' +
          'FOREIGN KEY (`' + w.col + '`) REFERENCES `transactions`(`transactionId`)'
        )
      }
    }
    return
  }

  // Postgres.
  const fkRows: any = await knex('information_schema.table_constraints as tc')
    .join('information_schema.constraint_column_usage as ccu', function () {
      this.on('tc.constraint_name', '=', 'ccu.constraint_name')
        .andOn('tc.table_schema', '=', 'ccu.table_schema')
    })
    .join('information_schema.key_column_usage as kcu', function () {
      this.on('tc.constraint_name', '=', 'kcu.constraint_name')
        .andOn('tc.table_schema', '=', 'kcu.table_schema')
    })
    .where('tc.constraint_type', 'FOREIGN KEY')
    .where('ccu.table_name', 'transactions_legacy')
    .whereIn('tc.table_name', ['outputs', 'commissions'])
    .select(
      'tc.table_name as table_name',
      'tc.table_schema as table_schema',
      'tc.constraint_name as constraint_name',
      'kcu.column_name as column_name'
    )
  for (const row of fkRows ?? []) {
    const schema = row.table_schema ?? 'public'
    const table = row.table_name
    const cname = row.constraint_name
    const col = row.column_name
    if (table == null || cname == null || col == null) continue
    await knex.raw(`ALTER TABLE "${schema}"."${table}" DROP CONSTRAINT "${cname}"`)
    await knex.raw(
      `ALTER TABLE "${schema}"."${table}" ADD CONSTRAINT "${cname}" ` +
      `FOREIGN KEY ("${col}") REFERENCES "transactions"("transactionId")`
    )
  }

  // Add FKs that should exist but don't (e.g. dropped by a prior partial
  // recovery run).
  const wantedPg: Array<{ table: string, col: string, cname: string }> = [
    { table: 'outputs', col: 'transactionId', cname: 'outputs_transactionid_foreign' },
    { table: 'outputs', col: 'spentBy', cname: 'outputs_spentby_foreign' },
    { table: 'commissions', col: 'transactionId', cname: 'commissions_transactionid_foreign' }
  ]
  for (const w of wantedPg) {
    const existing: any = await knex('information_schema.table_constraints as tc')
      .join('information_schema.key_column_usage as kcu', function () {
        this.on('tc.constraint_name', '=', 'kcu.constraint_name')
          .andOn('tc.table_schema', '=', 'kcu.table_schema')
      })
      .where('tc.constraint_type', 'FOREIGN KEY')
      .where('tc.table_name', w.table)
      .where('kcu.column_name', w.col)
      .first()
    if (existing == null) {
      await knex.raw(
        `ALTER TABLE "${w.table}" ADD CONSTRAINT "${w.cname}" ` +
        `FOREIGN KEY ("${w.col}") REFERENCES "transactions"("transactionId")`
      )
    }
  }
}

/**
 * Post-cutover sync-bridge backfill.
 *
 * Background: `runSchemaCutover` is run unconditionally on fresh installs
 * (wallet-infra/index.ts), then the toolbox's sync path inserts every replicated
 * row into `transactions_legacy`. Without a bridge step, those legacy-only
 * rows never appear in the canonical `transactions` + `actions` tables, and
 * downstream reads (`listOutputs`, `listActions`) that JOIN against the
 * canonical table return zero rows even though `outputs` and
 * `transactions_legacy` are fully populated.
 *
 * The bridge is now applied eagerly inside `StorageKnex.insertTransaction`
 * (post-cutover), but databases populated before that fix still carry the
 * stranded data. This helper migrates them in-place:
 *
 *   1. Find every `transactions_legacy` row with a non-empty `txid` whose
 *      `txid` does NOT yet appear in canonical `transactions`.
 *   2. For each, INSERT canonical `transactions` (`processing` derived from the
 *      legacy status) + INSERT `actions` per `(userId, txid)`.
 *   3. UPDATE every `outputs` and `commissions` row whose `transactionId` /
 *      `spentBy` points at the legacy id so it now points at the canonical id.
 *      Apply the same OFFSET trick as `runSchemaCutover` to avoid id collisions
 *      mid-update.
 *
 * Idempotent. Safe to call on every boot — a clean DB completes in a single
 * count query.
 */
export async function backfillLegacyOnlySync (knex: Knex): Promise<{
  migratedTransactions: number
  remappedOutputs: number
  remappedCommissions: number
  rebuiltFks: boolean
}> {
  const result = { migratedTransactions: 0, remappedOutputs: 0, remappedCommissions: 0, rebuiltFks: false }

  const hasLegacy = await knex.schema.hasTable('transactions_legacy')
  if (!hasLegacy) return result

  /*
   * Order of operations (must all execute on a single connection so the FK
   * bypass session var actually covers every write — pool acquires would
   * otherwise drop the SET on subsequent statements):
   *
   *   1. Migrate stranded legacy rows into canonical transactions + actions.
   *   2. Remap outputs / commissions FK values from legacy ids to canonical
   *      ids via the OFFSET trick. The existing FK still references
   *      `transactions_legacy` at this point — bypass FK enforcement.
   *   3. Drop unrecoverable orphans (rows whose legacy transactionId has no
   *      txid and therefore no canonical counterpart).
   *
   * Step 4 — the actual FK ADD CONSTRAINT — runs OUTSIDE the transaction.
   * On MySQL DDL is auto-commit; running it outside the transaction avoids
   * the implicit COMMIT mid-bypass.
   */
  const client = knexClient(knex)
  const now = new Date()

  await knex.transaction(async (trx) => {
    // Engine-specific FK bypass scoped to this connection's session.
    if (client === 'mysql') await trx.raw('SET FOREIGN_KEY_CHECKS=0')
    else if (client === 'pg') await trx.raw("SET LOCAL session_replication_role = 'replica'")
    else await trx.raw('PRAGMA foreign_keys = OFF')

    // Step 1: migrate stranded legacy rows.
    const stranded: Array<{
      legacyId: number
      userId: number
      txid: string
      status: string
      description: string | null
      reference: string | null
      isOutgoing: boolean | number | null
      satoshis: number | null
      rawTx: Buffer | null
      inputBEEF: Buffer | null
    }> = await trx('transactions_legacy as l')
      .leftJoin('transactions as t', 't.txid', 'l.txid')
      .whereNotNull('l.txid')
      .whereNull('t.transactionId')
      .select(
        trx.ref('l.transactionId').as('legacyId'),
        'l.userId',
        'l.txid',
        'l.status',
        'l.description',
        'l.reference',
        'l.isOutgoing',
        'l.satoshis',
        'l.rawTx',
        'l.inputBEEF'
      )

    const svc = new TransactionService(trx as unknown as Knex)
    for (const row of stranded) {
      const processing = transactionStatusToProcessing(row.status as TransactionStatus)
      const rawTxArr = row.rawTx != null ? Array.from(row.rawTx) : undefined
      const inputBeefArr = row.inputBEEF != null ? Array.from(row.inputBEEF) : undefined
      await svc.findOrCreateActionForTxid({
        userId: row.userId,
        txid: row.txid,
        isOutgoing: !!row.isOutgoing,
        description: row.description ?? '',
        satoshisDelta: row.satoshis ?? 0,
        reference: row.reference ?? '',
        rawTx: rawTxArr,
        inputBeef: inputBeefArr,
        processing,
        now
      })
      result.migratedTransactions++
    }

    /*
     * Step 1.5: drop unrecoverable orphans BEFORE the remap so collisions
     * cannot occur. An orphan output is one whose `transactionId` points at
     * a `transactions_legacy` row with a NULL `txid` — i.e., an unsigned
     * draft from a createAction call that never completed signing. Those
     * legacy rows have no canonical counterpart and can never be remapped.
     *
     * Their (transactionId, vout, userId) slots would otherwise collide with
     * canonical-id slots when a different legacy row maps to the same
     * canonical id by coincidence of integer overlap between the two
     * keyspaces.
     */
    const noTxidLegacyIds = trx('transactions_legacy').select('transactionId').whereNull('txid')
    const orphanOutputs = await trx('outputs')
      .whereIn('transactionId', noTxidLegacyIds)
      .del()
    const orphanSpentBy = await trx('outputs')
      .whereNotNull('spentBy')
      .whereIn('spentBy', trx('transactions_legacy').select('transactionId').whereNull('txid'))
      .update({ spentBy: null })
    const orphanCommissions = await trx('commissions')
      .whereIn('transactionId', trx('transactions_legacy').select('transactionId').whereNull('txid'))
      .del()
    if (orphanOutputs > 0 || orphanSpentBy > 0 || orphanCommissions > 0) {
      console.log(
        `[backfillLegacyOnlySync] cleared unrecoverable orphans: ` +
        `${orphanOutputs} outputs deleted, ` +
        `${orphanSpentBy} spentBy nulled, ` +
        `${orphanCommissions} commissions deleted ` +
        `(all referenced legacy transactions with no txid).`
      )
    }

    // Step 2: build legacy→canonical map by joining on txid (covers BOTH the
    // freshly-migrated set and any prior partial-recovery state) and remap
    // outputs / commissions with the OFFSET trick to avoid collisions.
    const mapRows: Array<{ legacyId: number, canonicalId: number }> = await trx('transactions_legacy as l')
      .join('transactions as t', 't.txid', 'l.txid')
      .select(trx.ref('l.transactionId').as('legacyId'), trx.ref('t.transactionId').as('canonicalId'))
    const legacyToCanonical = new Map<number, number>()
    for (const row of mapRows) legacyToCanonical.set(row.legacyId, row.canonicalId)

    const OFFSET = 1_000_000_000
    for (const [legacy, canonical] of legacyToCanonical) {
      if (legacy === canonical) continue
      const shifted = canonical + OFFSET
      const ru = await trx('outputs').where({ transactionId: legacy }).update({ transactionId: shifted })
      result.remappedOutputs += ru
      const rs = await trx('outputs').where({ spentBy: legacy }).update({ spentBy: shifted })
      result.remappedOutputs += rs
      const rc = await trx('commissions').where({ transactionId: legacy }).update({ transactionId: shifted })
      result.remappedCommissions += rc
    }
    await trx('outputs').where('transactionId', '>=', OFFSET).update({
      transactionId: trx.raw('?? - ?', ['transactionId', OFFSET])
    })
    await trx('outputs').where('spentBy', '>=', OFFSET).update({
      spentBy: trx.raw('?? - ?', ['spentBy', OFFSET])
    })
    await trx('commissions').where('transactionId', '>=', OFFSET).update({
      transactionId: trx.raw('?? - ?', ['transactionId', OFFSET])
    })

    // Restore FK enforcement before COMMIT.
    if (client === 'mysql') await trx.raw('SET FOREIGN_KEY_CHECKS=1')
    else if (client === 'sqlite') await trx.raw('PRAGMA foreign_keys = ON')
    // Postgres SET LOCAL auto-reverts on COMMIT.
  })

  // Step 4: rebuild the FK (outside the transaction — MySQL DDL is implicit
  // commit, and ADD CONSTRAINT validates rows against the new target).
  await rebuildLegacyFkTargets(knex)
  result.rebuiltFks = true

  return result
}
