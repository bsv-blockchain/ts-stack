import { linkSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Setup, SetupWallet } from '@bsv/wallet-toolbox'
import { backupToSQLite } from '../src/backup'

function setupWallet(): SetupWallet {
  return {
    chain: 'test',
    identityKey: `02${'11'.repeat(32)}`,
    keyDeriver: { rootKey: { toHex: () => '22'.repeat(32) } },
    storage: {
      addWalletStorageProvider: jest.fn(async () => {}),
      updateBackups: jest.fn(async () => '')
    }
  } as unknown as SetupWallet
}

describe('wallet backup file safety', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'wallet-example-backup-'))
    jest.spyOn(Setup, 'getEnv').mockReturnValue({ chain: 'test' } as never)
    jest.spyOn(Setup, 'createSQLiteKnex').mockReturnValue({} as never)
    jest.spyOn(Setup, 'createStorageKnex').mockResolvedValue({} as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  test('creates the backup file with owner-only permissions before SQLite opens it', async () => {
    const filePath = path.join(directory, 'backup.sqlite')

    await backupToSQLite(setupWallet(), filePath, 'security test')

    expect(lstatSync(filePath).mode & 0o777).toBe(0o600)
    expect(Setup.createSQLiteKnex).toHaveBeenCalledWith(filePath)
  })

  test('rejects a symbolic-link backup target before opening storage', async () => {
    const target = path.join(directory, 'target.sqlite')
    const filePath = path.join(directory, 'backup.sqlite')
    writeFileSync(target, 'do not overwrite')
    symlinkSync(target, filePath)

    await expect(backupToSQLite(setupWallet(), filePath, 'security test')).rejects.toThrow(
      'singly linked regular file'
    )
    expect(Setup.createSQLiteKnex).not.toHaveBeenCalled()
  })

  test('rejects a multiply linked backup target before opening storage', async () => {
    const target = path.join(directory, 'target.sqlite')
    const filePath = path.join(directory, 'backup.sqlite')
    writeFileSync(target, 'do not overwrite')
    linkSync(target, filePath)

    await expect(backupToSQLite(setupWallet(), filePath, 'security test')).rejects.toThrow(
      'singly linked regular file'
    )
    expect(Setup.createSQLiteKnex).not.toHaveBeenCalled()
  })
})
