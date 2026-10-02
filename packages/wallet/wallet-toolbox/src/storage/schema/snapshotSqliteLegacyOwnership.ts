import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import { snapshotGlobalIndexTriggers } from './snapshotGlobalIndexTriggers'
import { addSnapshotProfileIndexes, readSnapshotProfileIndexState } from './snapshotProfileIndexMigration'
import { addSnapshotRelationIndexes, readSnapshotRelationIndexState } from './snapshotRelationIndexMigration'
import { addSnapshotCertificateIndexes, readSnapshotCertificateIndexState } from './snapshotCertificateIndexMigration'
import { addSnapshotGlobalIndexes, readSnapshotGlobalIndexState } from './snapshotGlobalIndexMigration'
import { legacyNames } from './snapshotSqliteMembership'
export const retiredTables = [
  legacyNames.edges,
  legacyNames.keys,
  legacyNames.guards,
  legacyNames.profile,
  legacyNames.relation,
  legacyNames.certificate
]
export interface SchemaObject {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}
export async function legacySchema(k: Knex): Promise<SchemaObject[]> {
  return await k('sqlite_master')
    .whereIn('tbl_name', retiredTables)
    .select('type', 'name', 'tbl_name', 'sql')
    .orderBy(['type', 'name'])
}
function legacyTriggerNames(): Set<string> {
  const names = new Set(snapshotGlobalIndexTriggers(false).map(trigger => trigger.name))
  for (let id = 0; id < 8; id++)
    for (const event of ['insert', 'update', 'delete']) names.add(`snapshot_profile_${id}_${event}`)
  for (let id = 0; id < 2; id++)
    for (const side of ['map', 'left', 'right'])
      for (const event of ['insert', 'delete', 'before_update', 'after_update'])
        names.add(`snapshot_relation_${id}_${side}_${event}`)
  for (const side of ['field', 'parent'])
    for (const event of ['insert', 'delete', 'before_update', 'after_update'])
      names.add(`snapshot_certificate_${side}_${event}`)
  return names
}

/** Existing validators own the old definitions; complete states prevent bootstrap scans. */
export async function validateLegacy(k: Knex, config?: Knex.MigratorConfig): Promise<Set<string>> {
  await runInSeries(
    [
      readSnapshotProfileIndexState,
      readSnapshotRelationIndexState,
      readSnapshotCertificateIndexState,
      readSnapshotGlobalIndexState
    ],
    async read => {
      if (!(await read(k, config))) throw new WERR_INVALID_OPERATION('Prior snapshot migrations must be complete')
    }
  )
  await runInSeries(
    [addSnapshotProfileIndexes, addSnapshotRelationIndexes, addSnapshotCertificateIndexes, addSnapshotGlobalIndexes],
    async install => {
      await install(k)
    }
  )
  const names = legacyTriggerNames()
  const foreign: Array<{
    type: string
    name: string
    tbl_name: string
    sql: string
  }> = await k('sqlite_master').whereIn('type', ['trigger', 'view']).select('type', 'name', 'tbl_name', 'sql')
  for (const object of foreign)
    if (
      !(object.type === 'trigger' && names.has(object.name)) &&
      (retiredTables.includes(object.tbl_name) ||
        retiredTables.some(table => new RegExp(String.raw`\b${table}\b`, 'i').test(object.sql)))
    )
      throw new WERR_INVALID_OPERATION('Unowned object references legacy auxiliary data')
  return names
}
