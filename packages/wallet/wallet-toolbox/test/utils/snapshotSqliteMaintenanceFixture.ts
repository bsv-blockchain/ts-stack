import { runInSeries } from '../../src/utility/runInSeries'
import type { Knex } from 'knex'
import { readIdentity, identityDDL, type IdentityDefinition } from '../../src/storage/schema/snapshotSqliteIdentity'
import { numeric, relations, membershipTriggers } from '../../src/storage/schema/snapshotSqliteMembership'

export async function installMembershipDraft(k: Knex): Promise<void> {
  const definitions: IdentityDefinition[] = []
  await runInSeries(numeric, async source => {
    definitions.push(await readIdentity(k, source))
  })
  await k.transaction(async trx => {
    await runInSeries(definitions, async definition => {
      await runInSeries(identityDDL(definition), async ddl => {
        await trx.raw(ddl)
      })
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
    await runInSeries(membershipTriggers(definitions), async sql => {
      await trx.raw(sql)
    })
  })
}
