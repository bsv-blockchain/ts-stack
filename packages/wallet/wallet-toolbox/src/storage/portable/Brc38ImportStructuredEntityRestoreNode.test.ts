import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { Brc38PreparedStructuredEntityRestore } from './Brc38ImportStructuredEntityRestoreNode'

test('structured effect plans cannot enter a copied writer or call provenance/application effects', async () => {
  const sql = jest.fn(),
    apply = jest.fn(),
    trx = Object.assign(() => sql(), {
      isTransaction: true,
      client: { config: { client: 'better-sqlite3' } },
      raw: sql
    }) as unknown as Knex.Transaction,
    plan = new Brc38PreparedStructuredEntityRestore(
      {} as StorageKnex,
      {} as Brc38ImportJournalAdmission,
      {} as Brc38PreparedStreamedPage,
      { apply },
      [],
      []
    )
  await expect(plan.apply(trx)).rejects.toThrow('admitted source or native writer')
  expect(sql).not.toHaveBeenCalled()
  expect(apply).not.toHaveBeenCalled()
})
