import { runInSeries } from '../../src/utility/runInSeries'
import type { Knex } from 'knex'
import {
  readIdentity,
  identityDDL,
  sharedIdentityLayout,
  type IdentityDefinition
} from '../../src/storage/schema/snapshotSqliteIdentity'
import {
  numeric,
  relations,
  membershipTriggers,
  sharedMembershipTriggers
} from '../../src/storage/schema/snapshotSqliteMembership'

export async function installMembershipDraft(
  k: Knex,
  reduced = false,
  shared = false,
  completeEvents = false,
  sharedWitnesses = false
): Promise<void> {
  const definitions: IdentityDefinition[] = []
  await runInSeries(numeric, async source => {
    definitions.push(await readIdentity(k, source))
  })
  const layout = sharedWitnesses ? sharedIdentityLayout(definitions) : undefined
  if (sharedWitnesses && layout === undefined) throw new Error('Independent shared witness fixture layout missing')
  const planned = layout?.definitions ?? definitions
  await k.transaction(async trx => {
    await runInSeries(layout?.ddl ?? definitions.flatMap(definition => identityDDL(definition)), async ddl => {
      await trx.raw(ddl)
    })
    const sources = [
      ...numeric.map(source => source.table),
      ...relations.map(relation => relation.table),
      'certificate_fields'
    ]
    const old: Array<{ name: string }> = await trx('sqlite_master')
      .where('type', 'trigger')
      .whereIn('tbl_name', sources)
      .select('name')
    await runInSeries(old, async trigger => {
      if (/^snapshot_(profile|relation|certificate|global)_/.test(trigger.name))
        await trx.raw('DROP TRIGGER ??', [trigger.name])
    })
    await runInSeries(
      shared
        ? sharedMembershipTriggers(planned, undefined, completeEvents)
        : membershipTriggers(definitions, undefined, reduced),
      async sql => {
        await trx.raw(sql)
      }
    )
  })
}
