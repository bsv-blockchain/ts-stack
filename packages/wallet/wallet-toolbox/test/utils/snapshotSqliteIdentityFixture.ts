import { runInSeries } from '../../src/utility/runInSeries'
import type { Knex } from 'knex'
import type { IdentityDefinition } from '../../src/storage/schema/snapshotSqliteIdentity'
import { WERR_INVALID_OPERATION } from '../../src/sdk/WERR_errors'

/** Bound the background copy by the numeric source key; writes share its transaction. */
export async function copyIdentityPage(
  k: Knex,
  identity: IdentityDefinition,
  after: number,
  count = 256
): Promise<number | undefined> {
  if (!k.isTransaction) throw new WERR_INVALID_OPERATION('Identity bootstrap requires a transaction')
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(count) || count < 1 || count > 256)
    throw new WERR_INVALID_OPERATION('Invalid identity bootstrap position')
  const columns = identity.columns.map(column => column.name)
  const rows = await k(identity.source.table)
    .select(columns)
    .where(identity.source.key, '>', after)
    .orderBy(identity.source.key)
    .limit(count)
  await runInSeries(rows, async row => {
    const primary = [identity.source.key, ...(identity.source.owner ? [identity.source.owner] : [])]
    await k(identity.table).insert(row).onConflict(primary).merge()
  })
  return rows.length === count ? Number(rows.at(-1)[identity.source.key]) : undefined
}
