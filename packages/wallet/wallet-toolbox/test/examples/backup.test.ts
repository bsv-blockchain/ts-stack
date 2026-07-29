import { Setup, SetupWallet } from '../../out/src'
import { backupToSQLiteWithEvidence } from '../../examples/backup'

describe('wallet backup example', () => {
  test('attaches the selected SQLite provider and returns exact synchronization evidence', async () => {
    const sqliteKnex = { client: 'sqlite' }
    const backupStorage = { name: 'backup-storage' }
    const addWalletStorageProvider = jest.fn().mockResolvedValue(undefined)
    const updateBackups = jest.fn().mockResolvedValue('BACKUP CURRENT ACTIVE\nsyncToWriter complete')
    const setup = {
      chain: 'test',
      identityKey: `02${'11'.repeat(32)}`,
      keyDeriver: {
        rootKey: {
          toHex: () => '22'.repeat(32)
        }
      },
      storage: {
        addWalletStorageProvider,
        updateBackups
      }
    } as unknown as SetupWallet
    const getEnv = jest.spyOn(Setup, 'getEnv').mockReturnValue({ chain: 'test' } as never)
    const createSQLiteKnex = jest.spyOn(Setup, 'createSQLiteKnex').mockReturnValue(sqliteKnex as never)
    const createStorageKnex = jest.spyOn(Setup, 'createStorageKnex').mockResolvedValue(backupStorage as never)

    try {
      await expect(
        backupToSQLiteWithEvidence(setup, './operator-artifacts/backup.sqlite', 'test backup')
      ).resolves.toEqual({
        databaseName: 'test backup',
        filePath: './operator-artifacts/backup.sqlite',
        identityKey: setup.identityKey,
        log: 'BACKUP CURRENT ACTIVE\nsyncToWriter complete'
      })
      expect(createSQLiteKnex).toHaveBeenCalledWith('./operator-artifacts/backup.sqlite')
      expect(createStorageKnex).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseName: 'test backup',
          knex: sqliteKnex,
          rootKeyHex: '22'.repeat(32)
        })
      )
      expect(addWalletStorageProvider).toHaveBeenCalledWith(backupStorage)
      expect(updateBackups).toHaveBeenCalledTimes(1)
    } finally {
      getEnv.mockRestore()
      createSQLiteKnex.mockRestore()
      createStorageKnex.mockRestore()
    }
  })
})
