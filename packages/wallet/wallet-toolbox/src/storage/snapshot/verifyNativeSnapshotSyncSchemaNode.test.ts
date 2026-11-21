import { withBrc38NativePrivateContractFixture } from '../portable/Brc38NativePrivateContractFixture'
import { verifyNativeSnapshotSyncSchema } from './verifyNativeSnapshotSyncSchemaNode'

test('native sync schema admits exact optional receipts and refuses changed or unexpected current objects', async () => {
  const stop = new Error('Independent native sync schema rollback')
  await expect(
    withBrc38NativePrivateContractFixture(async fixture => {
      await fixture.withWriter(async trx => {
        const inspect = async (): Promise<void> => await verifyNativeSnapshotSyncSchema(trx)
        await inspect()
        // Every optional-family combination remains valid for older profiles.
        for (const table of ['snapshot_sync_content_receipts', 'snapshot_sync_journal_data_receipts']) {
          await trx.raw('SAVEPOINT independent_receipt')
          await trx.raw('DROP TABLE ??', [table])
          await inspect()
          await trx.raw('ROLLBACK TO independent_receipt')
          await trx.raw('RELEASE independent_receipt')
        }
        await trx.raw('SAVEPOINT independent_receipt')
        await trx.raw('DROP TABLE snapshot_sync_content_receipts')
        await trx.raw('DROP TABLE snapshot_sync_journal_data_receipts')
        await inspect()
        await trx.raw('ROLLBACK TO independent_receipt')
        await trx.raw('RELEASE independent_receipt')
        for (const sql of [
          'CREATE TABLE snapshot_sync_unexpected(value INTEGER)',
          'ALTER TABLE snapshot_sync_content_receipts ADD COLUMN unexpected INTEGER',
          'ALTER TABLE snapshot_sync_journal_data_receipts ADD COLUMN unexpected INTEGER',
          'CREATE INDEX independent_receipt_extra ON snapshot_sync_content_receipts(sessionId)',
          'CREATE TRIGGER independent_receipt_extra AFTER INSERT ON snapshot_sync_journal_data_receipts BEGIN SELECT 1; END',
          'DROP TRIGGER snapshot_sync_primary_change'
        ]) {
          await trx.raw('SAVEPOINT independent_receipt')
          await trx.raw(sql)
          await expect(inspect()).rejects.toThrow()
          await trx.raw('ROLLBACK TO independent_receipt')
          await trx.raw('RELEASE independent_receipt')
          await inspect()
        }
        throw stop
      })
    })
  ).rejects.toBe(stop)
}, 30000)
