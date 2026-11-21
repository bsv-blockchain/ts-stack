import { snapshotJournalFieldCacheTriggers, snapshotJournalFieldCacheNames } from './SnapshotJournalNativePayload'
import type { Knex } from 'knex'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  snapshotJournalSharedQuotaTriggers,
  snapshotJournalOrdinarySqliteQuotaTriggers,
  SNAPSHOT_JOURNAL_SHARED_QUOTA
} from './SnapshotJournalSharedQuota'
import { nativeQuotaDispatchDdl, nativeQuotaDispatchTriggers } from './SnapshotJournalNativeQuotaSql'

/** Choose from complete freshly observed definitions. Existing native layouts
 * are never converted. Every remaining definition must belong to one layout;
 * subsequent complete installation/erasure validation retains its own scope. */
export async function snapshotJournalQuotaLayout(k: Knex, ddl: readonly string[]) {
  const historical = snapshotJournalSharedQuotaTriggers(k, ddl)
  if (!isOwnedNativeSqlite(k)) return { ddl, triggers: historical, dispatch: [] as readonly string[] }
  const reduced = [
    ...nativeQuotaDispatchTriggers(ddl),
    ...(ddl.some(sql => sql.startsWith('CREATE TABLE ' + snapshotJournalFieldCacheNames.versions + '('))
      ? snapshotJournalFieldCacheTriggers(false)
      : [])
  ]
  const expected = (sql: readonly string[]) =>
    new Map(
      sql.map(value => {
        const match = /^CREATE (TRIGGER|VIEW) (\w+)/.exec(value)
        if (match === null) throw new WERR_INVALID_OPERATION('Invalid native quota definition')
        return [match[2], { type: match[1].toLowerCase(), sql: value }]
      })
    )
  const ordinary = snapshotJournalOrdinarySqliteQuotaTriggers(ddl)
  const layouts = [
    { triggers: historical, dispatch: [] as readonly string[] },
    { triggers: ordinary, dispatch: [] as readonly string[] },
    { triggers: reduced, dispatch: nativeQuotaDispatchDdl }
  ]
  const definitions = layouts.map(layout =>
    expected([...layout.triggers.map(trigger => trigger.sql), ...layout.dispatch])
  )
  const prefix = 'snapshot_reconciliation_quota_'
  const actual: Array<{ name: unknown; type: unknown; sql: unknown }> = await k('sqlite_schema')
    .whereRaw('lower(substr(name,1,?))=?', [prefix.length, prefix])
    .select(
      'name',
      'type',
      k.raw("CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=16384 THEN sql ELSE 0 END AS sql")
    )
    .limit(definitions[2].size + 1)
  let candidates = definitions.map((_, index) => index)
  for (const row of actual) {
    const matches = definitions.map(definition => {
      const value = typeof row.name === 'string' ? definition.get(row.name) : undefined
      return value !== undefined && value.type === row.type && value.sql === row.sql
    })
    if (!matches.some(Boolean)) throw new WERR_INVALID_OPERATION('Shared journal quota differs from its owned source')
    candidates = candidates.filter(index => matches[index])
    if (candidates.length === 0) throw new WERR_INVALID_OPERATION('Mixed native quota definitions')
  }
  let selected = candidates[0]
  if (actual.length === 0) {
    // Absence of observers cannot reclassify an occupied historical counter.
    // A fresh native installation chooses dispatch before creating any tables.
    const counter = await k('sqlite_schema').where({ type: 'table', name: SNAPSHOT_JOURNAL_SHARED_QUOTA }).first('name')
    selected = counter === undefined ? 2 : 0
  }
  if (selected === 2) {
    // A historical qualified executable lacks the guarded dispatch. It cannot
    // acquire this layout merely because the newer TypeScript source exists.
    // Check the genuine current kernel on every selection, never cache it.
    const protocol: Array<{ protocol: unknown }> = await k.raw('SELECT brc38_shared_quota_event_protocol() AS protocol')
    if (protocol.length !== 1 || protocol[0].protocol !== 'brc38-shared-quota-event/v1')
      throw new WERR_INVALID_OPERATION('Native shared quota dispatch requires its guarded kernel')
  }
  return { ddl, ...layouts[selected] }
}
