import { Knex } from 'knex'
import { DBType } from '../StorageReader'
import { KnexBackfillDriver } from './backfill.knex'
import { runBackfill } from './backfill.runner'

/**
 * §3 Step 6 of PROD_REQ_V7_TS.md — destructive cutover.
 *
 * Renames the legacy `transactions`, `proven_tx_reqs`, and `proven_txs` tables
 * to `*_legacy`, swaps the new-schema `transactions_new` table in as the new
 * canonical `transactions`, and remaps every FK value in `outputs`,
 * `commissions`, and `tx_labels_map` so that downstream storage methods
 * continue to read consistent rows.
 *
 * Not registered as a Knex migration because applying it changes the meaning
 * of table names that legacy storage methods still address. Run it only when
 * the calling application is ready to use the new-schema storage path.
 *
 * Safe to call:
 *  - on a populated DB that has not yet been cutover (performs full migration)
 *  - on a fresh DB (renames empty tables to match the post-cutover layout)
 *  - twice in a row (second call is a no-op via the `transactions_legacy`
 *    presence guard)
 *
 * The function is intentionally not wrapped in a Knex transaction: on SQLite
 * we need to toggle the per-connection `legacy_alter_table` pragma between
 * statements, which is incompatible with the deferred-commit semantics
 * Knex uses inside `knex.transaction`.
 */
export async function runSchemaCutover (knex: Knex): Promise<void> {
  const dbtype = await determineDBType(knex)
  const isSqlite = dbtype === 'SQLite'

  // Idempotency guard.
  if (await hasTable(knex, 'transactions_legacy')) return

  // Ensure backfill has populated transactions_new / actions before remapping.
  const txCount = await knex('transactions').count<{ c: number }>({ c: '*' }).first()
  const newTxCount = await knex('transactions_new').count<{ c: number }>({ c: '*' }).first()
  const hasLegacyData = (txCount?.c ?? 0) > 0
  const newTxPopulated = (newTxCount?.c ?? 0) > 0
  if (hasLegacyData && !newTxPopulated) {
    const driver = new KnexBackfillDriver(knex)
    await runBackfill(driver)
  }

  // Build mappings legacy.transactionId -> { newTxId, actionId }.
  const txMapRows: Array<{ legacyId: number, newTxId: number }> = hasLegacyData
    ? await knex('transactions as t')
        .join('transactions_new as v', 'v.txid', 't.txid')
        .select(knex.ref('t.transactionId').as('legacyId'), knex.ref('v.transactionId').as('newTxId'))
    : []
  const actionMapRows: Array<{ legacyId: number, actionId: number }> = hasLegacyData
    ? await knex('transactions as t')
        .join('transactions_new as v', 'v.txid', 't.txid')
        .join('actions as a', function joinAction () {
          this.on('a.userId', '=', 't.userId').andOn('a.transactionId', '=', 'v.transactionId')
        })
        .select(knex.ref('t.transactionId').as('legacyId'), knex.ref('a.actionId').as('actionId'))
    : []
  const legacyToNew = new Map(txMapRows.map(r => [r.legacyId, r.newTxId]))
  const legacyToAction = new Map(actionMapRows.map(r => [r.legacyId, r.actionId]))

  await disableFks(knex, isSqlite)
  try {
    // Drop FK rows that point at legacy transactionIds without a canonical
    // mapping (typically NULL-txid in-flight rows that never got a txid and
    // therefore have no `transactions_new` counterpart). Without this, the
    // remap would re-collide on (transactionId, vout, userId) when shifted
    // rows are brought back down onto the orphan keyspace.
    const allLegacyIds: number[] = hasLegacyData
      ? (await knex('transactions').select<{ transactionId: number }[]>('transactionId')).map(r => r.transactionId)
      : []
    const orphansForTxFk = allLegacyIds.filter(id => !legacyToNew.has(id))
    const orphansForActionFk = allLegacyIds.filter(id => !legacyToAction.has(id))
    if (orphansForTxFk.length > 0 || orphansForActionFk.length > 0) {
      console.log(`[schemaCutover] dropping FK rows for ${orphansForTxFk.length} unmapped legacy transactions (no txid)`)
      if (orphansForTxFk.length > 0) {
        await knex('outputs').whereIn('transactionId', orphansForTxFk).del()
        await knex('outputs').whereIn('spentBy', orphansForTxFk).update({ spentBy: null })
        await knex('commissions').whereIn('transactionId', orphansForTxFk).del()
      }
      if (orphansForActionFk.length > 0) {
        await knex('tx_labels_map').whereIn('transactionId', orphansForActionFk).del()
      }
    }

    // Remap downstream FK values with a temporary offset to dodge collisions
    // with the existing legacy keyspace during partial updates.
    const OFFSET = 1_000_000_000
    for (const [legacy, newId] of legacyToNew) {
      const shifted = newId + OFFSET
      await knex('outputs').where({ transactionId: legacy }).update({ transactionId: shifted })
      await knex('outputs').where({ spentBy: legacy }).update({ spentBy: shifted })
      await knex('commissions').where({ transactionId: legacy }).update({ transactionId: shifted })
    }
    await knex('outputs').where('transactionId', '>=', OFFSET).update({
      transactionId: knex.raw('?? - ?', ['transactionId', OFFSET])
    })
    await knex('outputs').where('spentBy', '>=', OFFSET).update({
      spentBy: knex.raw('?? - ?', ['spentBy', OFFSET])
    })
    await knex('commissions').where('transactionId', '>=', OFFSET).update({
      transactionId: knex.raw('?? - ?', ['transactionId', OFFSET])
    })

    for (const [legacy, actionId] of legacyToAction) {
      const shifted = actionId + OFFSET
      await knex('tx_labels_map').where({ transactionId: legacy }).update({ transactionId: shifted })
    }
    await knex('tx_labels_map').where('transactionId', '>=', OFFSET).update({
      transactionId: knex.raw('?? - ?', ['transactionId', OFFSET])
    })

    // legacy_alter_table = ON suppresses SQLite's automatic FK rewrite on
    // RENAME. We want it ON for the `transactions` rename only (so that the
    // outputs / commissions / tx_labels_map FKs keep pointing at the bare
    // string "transactions" and resolve to the new table after the swap).
    // For `proven_tx_reqs` and `proven_txs`, we want OFF so SQLite rewrites
    // the FK references inside proven_tx_reqs_legacy / transactions_legacy
    // (which target proven_txs) to follow the rename to proven_txs_legacy.
    // Without that rewrite, inserts into proven_tx_reqs_legacy fail because
    // the resolver looks up the bare "proven_txs" string and finds nothing.
    if (isSqlite) await knex.raw('PRAGMA legacy_alter_table = ON')
    await knex.schema.renameTable('transactions', 'transactions_legacy')
    if (isSqlite) await knex.raw('PRAGMA legacy_alter_table = OFF')

    await knex.schema.renameTable('proven_tx_reqs', 'proven_tx_reqs_legacy')
    await knex.schema.renameTable('proven_txs', 'proven_txs_legacy')

    // OFF (the default modern mode) ensures the rename of `transactions_new`
    // → `transactions` rewrites any FK reference that pointed at the original
    // new-schema name. tx_audit / actions originally targeted `transactions_new`
    // and follow the rename to `transactions` automatically.
    await knex.schema.renameTable('transactions_new', 'transactions')

    await rebuildTxLabelsMap(knex, dbtype)
  } finally {
    await enableFks(knex, isSqlite)
  }
}

/**
 * Inverse of `runSchemaCutover` for test rollback. Renames `*_legacy` tables back
 * to their canonical names and swaps `transactions` back to `transactions_new`.
 * Does not reverse the FK value remap — call this only when the cutover was
 * applied to seed data that the test no longer needs.
 */
export async function rollbackSchemaCutover (knex: Knex): Promise<void> {
  const dbtype = await determineDBType(knex)
  const isSqlite = dbtype === 'SQLite'
  await disableFks(knex, isSqlite)
  try {
    if (isSqlite) await knex.raw('PRAGMA legacy_alter_table = ON')
    if (await hasTable(knex, 'transactions')) {
      await knex.schema.renameTable('transactions', 'transactions_new')
    }
    if (await hasTable(knex, 'transactions_legacy')) {
      await knex.schema.renameTable('transactions_legacy', 'transactions')
    }
    if (await hasTable(knex, 'proven_tx_reqs_legacy')) {
      await knex.schema.renameTable('proven_tx_reqs_legacy', 'proven_tx_reqs')
    }
    if (await hasTable(knex, 'proven_txs_legacy')) {
      await knex.schema.renameTable('proven_txs_legacy', 'proven_txs')
    }
    if (isSqlite) await knex.raw('PRAGMA legacy_alter_table = OFF')
  } finally {
    await enableFks(knex, isSqlite)
  }
}

async function determineDBType (knex: Knex): Promise<DBType> {
  /*
   * Prefer the knex client identifier — it is set at construction and is
   * always available, avoiding a probe query and the engine-specific syntax
   * differences (SQLite has no `dual`, Postgres rejects `FROM dual`, MySQL
   * accepts it but only since 5.7+).
   *
   * Fall back to a probe-based detection only if the client is unrecognised.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: string | undefined = (knex as any).client?.config?.client ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (knex as any).client?.dialect
  if (client === 'mysql' || client === 'mysql2') return 'MySQL'
  if (client === 'pg' || client === 'postgres' || client === 'postgresql' ||
      client === 'pg-native' || client === 'pgnative') return 'Postgres'
  if (client === 'better-sqlite3' || client === 'sqlite3') return 'SQLite'

  // Probe fallback.
  try {
    const r: any = await knex.raw('SELECT version() AS v')
    const v = r?.rows?.[0]?.v ?? r?.[0]?.[0]?.v ?? r?.[0]?.v
    if (typeof v === 'string' && /PostgreSQL/i.test(v)) return 'Postgres'
    if (typeof v === 'string' && /MariaDB|MySQL/i.test(v)) return 'MySQL'
  } catch { /* ignore */ }
  try {
    await knex.raw('SELECT 1')
    return 'SQLite'
  } catch (e) {
    throw new Error('Unsupported database engine for schema cutover')
  }
}

async function hasTable (knex: Knex, name: string): Promise<boolean> {
  return await knex.schema.hasTable(name)
}

async function disableFks (knex: Knex, isSqlite: boolean): Promise<void> {
  if (isSqlite) {
    await knex.raw('PRAGMA foreign_keys = OFF')
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: string | undefined = (knex as any).client?.config?.client
  if (client === 'pg' || client === 'postgres' || client === 'postgresql') {
    // `session_replication_role = replica` makes Postgres skip FK / triggers
    // for the duration of the session. Restored to 'origin' by enableFks.
    await knex.raw("SET session_replication_role = 'replica'")
  } else {
    await knex.raw('SET FOREIGN_KEY_CHECKS=0')
  }
}

async function enableFks (knex: Knex, isSqlite: boolean): Promise<void> {
  if (isSqlite) {
    await knex.raw('PRAGMA foreign_keys = ON')
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: string | undefined = (knex as any).client?.config?.client
  if (client === 'pg' || client === 'postgres' || client === 'postgresql') {
    await knex.raw("SET session_replication_role = 'origin'")
  } else {
    await knex.raw('SET FOREIGN_KEY_CHECKS=1')
  }
}

async function rebuildTxLabelsMap (knex: Knex, dbtype: DBType): Promise<void> {
  if (dbtype === 'SQLite') {
    await knex.schema.createTable('tx_labels_map_new', table => {
      table.timestamp('created_at', { precision: 3 }).defaultTo(knex.fn.now()).notNullable()
      table.timestamp('updated_at', { precision: 3 }).defaultTo(knex.fn.now()).notNullable()
      table.integer('txLabelId').unsigned().references('txLabelId').inTable('tx_labels').notNullable()
      table.integer('transactionId').unsigned().references('actionId').inTable('actions').notNullable()
      table.boolean('isDeleted').notNullable().defaultTo(false)
      table.unique(['txLabelId', 'transactionId'])
    })
    await knex.raw(
      'INSERT INTO tx_labels_map_new (created_at, updated_at, txLabelId, transactionId, isDeleted) ' +
      'SELECT created_at, updated_at, txLabelId, transactionId, isDeleted FROM tx_labels_map'
    )
    await knex.schema.dropTable('tx_labels_map')
    await knex.schema.renameTable('tx_labels_map_new', 'tx_labels_map')
    await knex.schema.alterTable('tx_labels_map', table => {
      table.index('transactionId')
      table.index(['transactionId', 'isDeleted'], 'idx_tx_labels_map_tx_deleted')
    })
    return
  }

  if (dbtype === 'Postgres') {
    /*
     * Postgres FK drop requires the constraint name. Query
     * information_schema.table_constraints + key_column_usage to find any FK
     * on tx_labels_map.transactionId, drop them, then add the new FK pointing
     * at actions(actionId).
     */
    const fkRows: any = await knex('information_schema.table_constraints as tc')
      .join('information_schema.key_column_usage as kcu', function () {
        this.on('tc.constraint_name', '=', 'kcu.constraint_name')
          .andOn('tc.table_schema', '=', 'kcu.table_schema')
      })
      .where('tc.table_name', 'tx_labels_map')
      .where('kcu.column_name', 'transactionId')
      .where('tc.constraint_type', 'FOREIGN KEY')
      .select('tc.constraint_name as constraint_name', 'tc.table_schema as table_schema')
    for (const row of fkRows ?? []) {
      const name = row.constraint_name
      const schema = row.table_schema ?? 'public'
      if (name != null) {
        await knex.raw(`ALTER TABLE "${schema}"."tx_labels_map" DROP CONSTRAINT "${name}"`)
      }
    }
    await knex.raw(
      'ALTER TABLE tx_labels_map ADD CONSTRAINT fk_tx_labels_map_action ' +
      'FOREIGN KEY ("transactionId") REFERENCES actions("actionId")'
    )
    return
  }

  // MySQL.
  const dbRow: any = (await knex.raw('SELECT DATABASE() AS d'))[0]
  const dbName = Array.isArray(dbRow) ? dbRow[0]?.d : dbRow?.d
  const fkRows: any = await knex('information_schema.KEY_COLUMN_USAGE')
    .select('CONSTRAINT_NAME')
    .where({
      TABLE_SCHEMA: dbName,
      TABLE_NAME: 'tx_labels_map',
      COLUMN_NAME: 'transactionId'
    })
    .whereNotNull('REFERENCED_TABLE_NAME')
  for (const row of fkRows ?? []) {
    const constraintName = row.CONSTRAINT_NAME ?? row.constraint_name
    if (constraintName != null) {
      await knex.raw('ALTER TABLE tx_labels_map DROP FOREIGN KEY `' + constraintName + '`')
    }
  }
  await knex.raw(
    'ALTER TABLE tx_labels_map ADD CONSTRAINT fk_tx_labels_map_action ' +
    'FOREIGN KEY (transactionId) REFERENCES actions(actionId)'
  )
}
