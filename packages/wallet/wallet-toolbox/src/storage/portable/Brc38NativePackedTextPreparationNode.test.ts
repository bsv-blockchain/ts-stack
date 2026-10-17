import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { withBrc38PreparedPrivatePackedText } from './Brc38NativePackedTextPreparationNode'

test('copied private labels cannot stage TEXT or enter the installer callback', async () => {
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
    } as unknown as KnexBrc38StagingStore
  await expect(
    withBrc38PreparedPrivatePackedText(
      copied,
      { data: { kind: 'header' } } as unknown as Brc38PreparedStreamedPage,
      new Map(),
      Date.now() + 60000,
      undefined,
      work
    )
  ).rejects.toThrow('retained source')
  expect(sql).not.toHaveBeenCalled()
  expect(work).not.toHaveBeenCalled()
})
test('TEXT preparation observes the original cancellation before native work or allocation', async () => {
  const sql = jest.fn(),
    work = jest.fn(),
    controller = new AbortController(),
    reason = new Error('original TEXT cancellation')
  controller.abort(reason)
  await expect(
    withBrc38PreparedPrivatePackedText(
      { assertPrivateNativeDestination: sql } as unknown as KnexBrc38StagingStore,
      {} as Brc38PreparedStreamedPage,
      new Map(),
      Date.now() + 60000,
      controller.signal,
      work
    )
  ).rejects.toBe(reason)
  expect(sql).not.toHaveBeenCalled()
  expect(work).not.toHaveBeenCalled()
})
