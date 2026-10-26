import { Setup, SetupEnv, SetupWallet } from '@bsv/wallet-toolbox'
import { chmodSync, closeSync, constants, lstatSync, openSync } from 'node:fs'

import { runArgv2Function } from './runArgv2Function'

/**
 * @publicbody
 */
export async function backup(): Promise<void> {
  const env = Setup.getEnv('test')
  await backupWalletClient(env, env.identityKey)
}

/**
 * @publicbody
 */
export async function backupWalletClient(env: SetupEnv, identityKey: string): Promise<void> {
  const setup = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[identityKey]
  })
  try {
    await backupToSQLite(setup)
  } finally {
    await setup.wallet.destroy()
  }
}

/**
 * Writes sensitive wallet history to SQLite. The destination must be inside a
 * trusted, owner-only directory because SQLite may create journal files beside
 * the database. Existing symbolic or multiply linked targets are rejected and the database
 * itself is restricted to mode `0600` before it is opened.
 *
 * @publicbody
 */
export async function backupToSQLite(
  setup: SetupWallet,
  filePath?: string,
  databaseName?: string
): Promise<void> {
  const env = Setup.getEnv(setup.chain)
  filePath ||= `backup_${setup.identityKey}.sqlite`
  databaseName ||= `${setup.identityKey} backup`
  preparePrivateBackupFile(filePath)

  const backup = await Setup.createStorageKnex({
    env,
    knex: Setup.createSQLiteKnex(filePath),
    databaseName,
    rootKeyHex: setup.keyDeriver.rootKey.toHex()
  })

  await setup.storage.addWalletStorageProvider(backup)

  await setup.storage.updateBackups()
}

function preparePrivateBackupFile(filePath: string): void {
  if (filePath === ':memory:' || filePath.startsWith('file:')) {
    throw new Error('A wallet backup must use an ordinary persistent file path')
  }
  try {
    const details = lstatSync(filePath)
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
      throw new Error('The wallet backup path must be a singly linked regular file')
    }
    chmodSync(filePath, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const descriptor = openSync(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600
    )
    closeSync(descriptor)
  }
}

if (require.main === module) void runArgv2Function(module.exports)
