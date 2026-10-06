import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import { installGeneration, metadata, readPlan, validateInstalled } from './snapshotSqliteIndexGeneration'
import { copyGenerationPage } from './snapshotSqliteIndexBootstrap'
import { retireGenerationPage } from './snapshotSqliteIndexRetirement'
/** Pull one page at a time, yielding foreground execution between commits. */
async function completePages(read: () => Promise<{ complete: boolean }>): Promise<void> {
  let complete = false
  function* pending() {
    while (!complete) yield undefined
  }
  await runInSeries(pending(), async () => {
    complete = (await read()).complete
    if (!complete) await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

/** Additive SQLite repair; MySQL retains its existing native maintenance. */
export async function migrateGeneration(k: Knex): Promise<void> {
  if (String(k.client.config.client).includes('mysql')) return
  if (k.isTransaction) throw new WERR_INVALID_OPERATION('SQLite generation requires independent bounded transactions')
  const plan = await installGeneration(k, k.client.config.migrations)
  await completePages(() => copyGenerationPage(k, plan))
  await completePages(() => retireGenerationPage(k, plan))
}
/** Source rows are unchanged; an older snapshot implementation cannot use retired indexes. */
export function refuseGenerationDowngrade(k: Knex): Promise<void> {
  if (String(k.client.config.client).includes('mysql')) return Promise.resolve()
  return Promise.reject(
    new WERR_INVALID_OPERATION(
      'SQLite snapshot generation downgrade is unsupported; preserve source rows and use a forward migration'
    )
  )
}
/** Only StorageKnex.dropAllData may remove this generation without rebuilding legacy indexes. */
export async function dropGenerationForDataDeletion(k: Knex): Promise<void> {
  if (!String(k.client.config.client).includes('sqlite')) return
  await k.transaction(async trx => {
    if (!(await trx.schema.hasTable(metadata))) return
    await trx(metadata)
      .where('id', 0)
      .update({ retireTable: trx.ref('retireTable') })
    const plan = await readPlan(trx)
    await validateInstalled(trx, plan)
    await runInSeries([...plan.triggers].reverse(), async sql => {
      const name = /^CREATE TRIGGER ("[^"]+"|\w+)/.exec(sql)![1].replaceAll('"', '')
      await trx.raw('DROP TRIGGER ??', [name])
    })
    await runInSeries([...plan.ddl].reverse(), async sql => {
      const match = /^CREATE TABLE "([^"]+)"/.exec(sql)
      if (match) await trx.schema.dropTable(match[1])
    })
    await trx.schema.dropTable('snapshot_index_install_lock_v2')
  })
}
