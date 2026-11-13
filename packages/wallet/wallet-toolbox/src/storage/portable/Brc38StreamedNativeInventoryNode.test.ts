import type { Knex } from 'knex'
import {
  inspectBrc38PrivateStreamedNativeInventory,
  inspectBrc38ReadyPublishedStreamedNativeInventory,
  inspectBrc38PublishedCopyStreamedInventory
} from './Brc38StreamedNativeInventoryNode'
import { isBrc38PublishedCopyInspection } from './Brc38PublishedProfileNode'
import { importPageFixture } from './Brc38ImportPageFixture'

/** Entry refusal is before any SQL/native process or untrusted allocation.
 * Full actual all13 inventory/postimage cases require the freshly admitted
 * packaged Linux private engine; this source case is not that qualification. */
test('counterfeit native class/config cannot inspect or authorize an inventory', async () => {
  const sql = jest.fn(() => {
      throw new Error('SQL must not run')
    }),
    k = Object.assign(sql, {
      isTransaction: true,
      client: { config: { client: class OwnedNativeSqliteClient {} }, dialect: 'sqlite3' }
    }) as unknown as Knex.Transaction,
    f = importPageFixture()
  await expect(inspectBrc38PrivateStreamedNativeInventory(k, f.admission)).rejects.toThrow('inventory differs')
  expect(sql).not.toHaveBeenCalled()
})
test('cancelled inventory inspection retains the original reason before SQL or allocation', async () => {
  const sql = jest.fn(() => {
      throw new Error('SQL must not run')
    }),
    controller = new AbortController(),
    reason = new Error('synthetic inventory cancellation'),
    f = importPageFixture()
  controller.abort(reason)
  await expect(
    inspectBrc38PrivateStreamedNativeInventory(sql as unknown as Knex.Transaction, f.admission, controller.signal)
  ).rejects.toBe(reason)
  expect(sql).not.toHaveBeenCalled()
})
test('copied native flags cannot select the published READY inventory path', async () => {
  const sql = jest.fn(),
    k = Object.assign(sql, {
      isTransaction: true,
      client: { config: { client: 'OwnedNativeSqliteClient' } }
    }) as unknown as Knex.Transaction,
    f = importPageFixture()
  await expect(inspectBrc38ReadyPublishedStreamedNativeInventory(k, f.admission)).rejects.toThrow(
    'authenticated published-profile'
  )
  expect(sql).not.toHaveBeenCalled()
})
test('a read-only configuration and copied profile labels cannot grant copied-wallet inspection', async () => {
  const sql = jest.fn(),
    k = Object.assign(sql, {
      isTransaction: true,
      isCompleted: () => false,
      client: { config: { client: 'better-sqlite3', connection: { options: { readonly: true } } } }
    }) as unknown as Knex.Transaction,
    f = importPageFixture()
  expect(isBrc38PublishedCopyInspection(k)).toBe(false)
  await expect(inspectBrc38PublishedCopyStreamedInventory(k, f.admission)).rejects.toThrow(
    'actual retained published-copy inspection'
  )
  expect(sql).not.toHaveBeenCalled()
})
