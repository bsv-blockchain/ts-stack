import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import { readPlan, validateInstalled, metadata, progress } from './snapshotSqliteIndexGeneration'
import { valid, type Position } from './snapshotSqliteIndexBootstrap'
export const migration = '2026-10-02-001 repair snapshot SQLite conflict maintenance'
export type SnapshotIndexState = boolean | 'v2'
/** The caller holds the same pinned view that will read all selected pages. */
export async function readGenerationIndexState(
  k: Knex,
  config?: Knex.MigratorConfig
): Promise<false | 'v2' | undefined> {
  if (!String(k.client.config.client).includes('sqlite') || !(await k.schema.hasTable(metadata))) return undefined
  const plan = await readPlan(k)
  await validateInstalled(k, plan)
  const rows: Position[] = await k(progress).select('*').orderBy('stream').limit(13)
  if (rows.length !== 12 || rows.some((row, index) => row.stream !== index || !valid(row)))
    throw new WERR_INVALID_OPERATION('Invalid generation progress')
  const state = await k(metadata).where('id', 0).first('complete')
  const journal = config?.tableName ?? 'knex_migrations'
  const journalSchema = k.schema
  if (config?.schemaName !== undefined) void journalSchema.withSchema(config.schemaName)
  let published = false
  if (await journalSchema.hasTable(journal)) {
    const query = k(journal).where('name', migration)
    if (config?.schemaName !== undefined) void query.withSchema(config.schemaName)
    published = (await query.first('name')) !== undefined
  }
  if (state.complete === 0) {
    if (published) throw new WERR_INVALID_OPERATION('Published generation is incomplete')
    return false
  }
  if (rows.some(row => row.complete !== 1))
    throw new WERR_INVALID_OPERATION('Completed generation has unfinished streams')
  return published ? 'v2' : false
}
