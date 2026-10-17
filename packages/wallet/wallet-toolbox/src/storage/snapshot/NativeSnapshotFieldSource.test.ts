import type { StorageKnex } from '../StorageKnex'
import type { RetainedReadSnapshot } from './RetainedReadSnapshot'
import { createKnexWalletSnapshotFieldReader } from './KnexWalletReadSnapshot'

test('a copied native label cannot admit metadata or a field extent before SQL', async () => {
  const database = jest.fn(),
    token = { isNativeProfile: true, queryOnly: true },
    storage = { toDb: jest.fn(() => database) } as unknown as StorageKnex,
    view = {
      read: async <T>(run: (input: unknown) => Promise<T>): Promise<T> => await run(token)
    } as RetainedReadSnapshot,
    reader = createKnexWalletSnapshotFieldReader(storage, 1, 'aa'.repeat(32), view)
  await expect(reader.readMetadataPage('provenTxReqs')).rejects.toThrow('Actual native field snapshot required')
  await expect(
    reader.readFieldExtent(
      'provenTxReqs',
      { version: 1, snapshotId: 'aa'.repeat(32), table: 'provenTxReqs', after: [1] },
      'history',
      0,
      1,
      { kind: 'utf8', bytes: 100 }
    )
  ).rejects.toThrow('Actual native field snapshot required')
  expect(database).not.toHaveBeenCalled()
})
