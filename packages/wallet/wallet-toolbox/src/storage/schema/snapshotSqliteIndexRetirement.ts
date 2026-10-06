import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import { metadata, validateInstalled, type Plan } from './snapshotSqliteIndexGeneration'
import { legacySchema, retiredTables, type SchemaObject } from './snapshotSqliteLegacyOwnership'

/** Remove at most 256 obsolete rows; drop only an already-empty owned table. */
export async function retireGenerationPage(
  k: Knex,
  plan: Plan
): Promise<{ complete: boolean; removed: number; table: string | undefined }> {
  return await k.transaction(async trx => {
    await trx(metadata)
      .where('id', 0)
      .update({ retireTable: trx.ref('retireTable') })
    await validateInstalled(trx, plan)
    const state: { complete: number; legacy: string; retireTable: number } = await trx(metadata).where('id', 0).first()
    if (state.complete !== 1) throw new WERR_INVALID_OPERATION('Cannot retire before generation copy completes')
    let expected: SchemaObject[]
    try {
      expected = JSON.parse(state.legacy)
    } catch {
      throw new WERR_INVALID_OPERATION('Invalid legacy ownership receipt')
    }
    if (
      !Array.isArray(expected) ||
      expected.some(
        row =>
          typeof row !== 'object' ||
          row === null ||
          !retiredTables.includes(row.tbl_name) ||
          !['table', 'index'].includes(row.type) ||
          typeof row.name !== 'string' ||
          (row.sql !== null && typeof row.sql !== 'string')
      )
    )
      throw new WERR_INVALID_OPERATION('Invalid legacy ownership receipt')
    const remaining = expected.filter(row => retiredTables.indexOf(row.tbl_name) >= state.retireTable)
    if (JSON.stringify(await legacySchema(trx)) !== JSON.stringify(remaining))
      throw new WERR_INVALID_OPERATION('Legacy retirement schema changed')
    const table = retiredTables[state.retireTable]
    if (table === undefined) return { complete: true, removed: 0, table }
    const removed = await trx(table)
      .whereIn('_rowid_', trx(table).select('_rowid_').orderBy('_rowid_').limit(256))
      .delete()
    if (!Number.isSafeInteger(removed) || removed < 0 || removed > 256)
      throw new WERR_INVALID_OPERATION('Invalid retirement row count')
    if (removed === 0) {
      await trx.schema.dropTable(table)
      await trx(metadata)
        .where('id', 0)
        .update({ retireTable: state.retireTable + 1 })
    }
    return {
      complete: removed === 0 && state.retireTable + 1 === retiredTables.length,
      removed,
      table
    }
  })
}
