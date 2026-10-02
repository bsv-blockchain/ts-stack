import type { Knex } from 'knex'
import { readIdentity, identityDDL, type IdentityDefinition } from '../../src/storage/schema/snapshotSqliteIdentity'
import { numeric, relations, membershipTriggers } from '../../src/storage/schema/snapshotSqliteMembership'

export async function installMembershipDraft(k: Knex): Promise<void> {
  const definitions: IdentityDefinition[] = []
  for (const source of numeric) definitions.push(await readIdentity(k, source))
  await k.transaction(async trx => {
    for (const definition of definitions) for (const ddl of identityDDL(definition)) await trx.raw(ddl)
    const sources = [
      ...numeric.map(source => source.table),
      ...relations.map(relation => relation.table),
      'certificate_fields'
    ]
    const old: Array<{ name: string }> = await trx('sqlite_master')
      .where('type', 'trigger')
      .whereIn('tbl_name', sources)
      .select('name')
    for (const trigger of old)
      if (/^snapshot_(profile|relation|certificate|global)_/.test(trigger.name))
        await trx.raw('DROP TRIGGER ??', [trigger.name])
    for (const sql of membershipTriggers(definitions)) await trx.raw(sql)
  })
}
