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
  let cursor: Pick<SchemaObject, 'type' | 'name'> | undefined
  for (;;) {
    // Keep every complete definition, but read one at a time so a large
    // collection of ordinary triggers cannot exhaust the native reply budget.
    const query = k('sqlite_master').whereIn('type', ['trigger', 'view'])
    if (cursor !== undefined) {
      const prior = cursor
      void query.andWhere(after => {
        void after.where('type', '>', prior.type).orWhere(sameType => {
          void sameType.where('type', prior.type).andWhere('name', '>', prior.name)
        })
      })
    }
    const object: SchemaObject | undefined = await query
      .select('type', 'name', 'tbl_name', 'sql')
      .orderBy(['type', 'name'])
      .first()
    if (object === undefined) break
    if (
      !(object.type === 'trigger' && names.has(object.name)) &&
      (retiredTables.includes(object.tbl_name) ||
        retiredTables.some(table => new RegExp(String.raw`\b${table}\b`, 'i').test(String(object.sql))))
    )
      throw new WERR_INVALID_OPERATION('Unowned object references legacy auxiliary data')
    cursor = { type: object.type, name: object.name }
  }
  return names
}
