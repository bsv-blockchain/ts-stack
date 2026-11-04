import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import {
  prepareBrc38ImportExistingFieldTargets,
  assertBrc38ImportExistingFieldTargets
} from './Brc38ImportExistingRows'

test('copied native reader labels cannot query occupied-target field metadata', async () => {
  const sql = jest.fn(),
    trx = Object.assign(() => sql(), {
      isTransaction: true,
      client: { config: { client: class OwnedNativeSqliteClient {} } }
    }) as unknown as Knex.Transaction
  await expect(
    prepareBrc38ImportExistingFieldTargets(trx, {} as StorageKnex, 1, 'outputs', [], 65536)
  ).rejects.toThrow()
  expect(sql).not.toHaveBeenCalled()
})
test('original metadata preparation cancellation precedes native membership and SQL', async () => {
  const controller = new AbortController(),
    reason = new Error('original occupied metadata cancellation')
  controller.abort(reason)
  await expect(
    prepareBrc38ImportExistingFieldTargets(
      {} as Knex.Transaction,
      {} as StorageKnex,
      1,
      'outputs',
      [],
      65536,
      controller.signal
    )
  ).rejects.toBe(reason)
})
test('copied writer labels cannot approve previously prepared field metadata', async () => {
  const sql = jest.fn(),
    trx = Object.assign(() => sql(), {
      isTransaction: true,
      client: { config: { client: class OwnedNativeSqliteClient {} } }
    }) as unknown as Knex.Transaction
  await expect(
    assertBrc38ImportExistingFieldTargets(trx, {} as StorageKnex, 1, 'outputs', [], [], 65536)
  ).rejects.toThrow()
  expect(sql).not.toHaveBeenCalled()
})
