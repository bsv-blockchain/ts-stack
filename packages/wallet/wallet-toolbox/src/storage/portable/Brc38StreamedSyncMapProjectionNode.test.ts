import type { Knex } from 'knex'
import { Brc38StreamedSyncMapProjectionNode } from './Brc38StreamedSyncMapProjectionNode'

test('copied destination labels cannot acquire projection files or source callbacks', async () => {
  const sql = jest.fn(),
    read = jest.fn(),
    openIndex = jest.fn(),
    trx = Object.assign(() => sql(), {
      isTransaction: true,
      client: { config: { client: 'better-sqlite3' } }
    }) as unknown as Knex.Transaction
  await expect(
    Brc38StreamedSyncMapProjectionNode.prepare(
      trx,
      {
        importId: 'f7fc9300-9b15-4d8d-8b1c-a3bead817342',
        bindingSha256: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        userId: 1
      },
      { encoding: 'utf8', length: 2, sha256: 'c'.repeat(64), read, openIndex },
      {
        privateParent: '/nonexistent/private-parent',
        maximumTemporaryFileBytes: 2097152,
        maximumMembers: 100,
        maximumOutputBytes: 1000,
        maximumScalarBytes: 4096,
        expiresAt: Date.now() + 60000
      }
    )
  ).rejects.toThrow('actual private read-only')
  expect(sql).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(openIndex).not.toHaveBeenCalled()
})

test('cancelled projection retains its original reason before destination or filesystem access', async () => {
  const controller = new AbortController(),
    reason = new Error('original projection cancellation'),
    read = jest.fn(),
    openIndex = jest.fn()
  controller.abort(reason)
  await expect(
    Brc38StreamedSyncMapProjectionNode.prepare(
      {} as Knex.Transaction,
      {
        importId: 'f7fc9300-9b15-4d8d-8b1c-a3bead817342',
        bindingSha256: 'a'.repeat(64),
        archiveSha256: 'b'.repeat(64),
        userId: 1
      },
      { encoding: 'utf8', length: 2, sha256: 'c'.repeat(64), read, openIndex },
      {
        privateParent: '/nonexistent/private-parent',
        maximumTemporaryFileBytes: 2097152,
        maximumMembers: 100,
        maximumOutputBytes: 1000,
        maximumScalarBytes: 4096,
        expiresAt: Date.now() + 60000,
        signal: controller.signal
      }
    )
  ).rejects.toBe(reason)
  expect(read).not.toHaveBeenCalled()
  expect(openIndex).not.toHaveBeenCalled()
})
