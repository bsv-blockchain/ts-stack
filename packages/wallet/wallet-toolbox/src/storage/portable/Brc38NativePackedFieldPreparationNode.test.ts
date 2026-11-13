import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { withBrc38PreparedPrivatePackedFields } from './Brc38NativePackedFieldPreparationNode'

test('copied private labels cannot prepare even a header or enter a caller before actual native membership', async () => {
  const sql = jest.fn(),
    work = jest.fn(),
    claimed = Object.assign(
      () => {
        sql()
      },
      {
        isTransaction: false,
        client: { config: { client: class OwnedNativeSqliteClient {} } }
      }
    ) as unknown as Knex,
    copied = {
      knex: claimed,
      assertPrivateNativeDestination: () => undefined,
      withPrivateNativeDatabase: sql
    } as unknown as KnexBrc38StagingStore,
    page = {
      data: { kind: 'header' },
      budget: { maximum: 16777216, remaining: 16777216 }
    } as unknown as Brc38PreparedStreamedPage
  await expect(withBrc38PreparedPrivatePackedFields(copied, page, Date.now() + 60000, undefined, work)).rejects.toThrow(
    'actual retained source'
  )
  expect(sql).not.toHaveBeenCalled()
  expect(work).not.toHaveBeenCalled()
})
test('original cancellation wins before native SQL, page allocation or caller entry', async () => {
  const sql = jest.fn(),
    work = jest.fn(),
    controller = new AbortController(),
    reason = new Error('original staged-field cancellation')
  controller.abort(reason)
  await expect(
    withBrc38PreparedPrivatePackedFields(
      { assertPrivateNativeDestination: sql } as unknown as KnexBrc38StagingStore,
      {} as Brc38PreparedStreamedPage,
      Date.now() + 60000,
      controller.signal,
      work
    )
  ).rejects.toBe(reason)
  expect(sql).not.toHaveBeenCalled()
  expect(work).not.toHaveBeenCalled()
})
