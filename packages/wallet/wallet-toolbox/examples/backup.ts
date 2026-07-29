import { Setup, SetupEnv, SetupWallet } from '../out/src/index.js'

export interface BackupEvidence {
  databaseName: string
  filePath: string
  identityKey: string
  log: string
}

/**
 * Back up the default configured test wallet to a local SQLite database.
 */
export async function backup(): Promise<void> {
  const env = Setup.getEnv('test')
  await backupWalletClient(env, env.identityKey)
}

/**
 * Back up one configured wallet client while preserving the historical
 * example's Promise<void> contract.
 */
export async function backupWalletClient(env: SetupEnv, identityKey: string): Promise<void> {
  await backupWalletClientWithEvidence(env, identityKey)
}

/**
 * Back up one configured wallet client and return non-secret execution
 * evidence suitable for a manual integration assertion or operator record.
 */
export async function backupWalletClientWithEvidence(env: SetupEnv, identityKey: string): Promise<BackupEvidence> {
  const setup = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[identityKey]
  })
  try {
    return await backupToSQLiteWithEvidence(setup)
  } finally {
    await setup.wallet.destroy()
  }
}

/**
 * Attach a local SQLite backup provider while preserving the historical
 * example's Promise<void> contract.
 */
export async function backupToSQLite(setup: SetupWallet, filePath?: string, databaseName?: string): Promise<void> {
  await backupToSQLiteWithEvidence(setup, filePath, databaseName)
}

/**
 * Attach a local SQLite backup provider and return non-secret synchronization
 * evidence.
 */
export async function backupToSQLiteWithEvidence(
  setup: SetupWallet,
  filePath = `backup_${setup.identityKey}.sqlite`,
  databaseName = `${setup.identityKey} backup`
): Promise<BackupEvidence> {
  const env = Setup.getEnv(setup.chain)
  const backupStorage = await Setup.createStorageKnex({
    env,
    knex: Setup.createSQLiteKnex(filePath),
    databaseName,
    rootKeyHex: setup.keyDeriver.rootKey.toHex()
  })

  await setup.storage.addWalletStorageProvider(backupStorage)
  const log = await setup.storage.updateBackups()
  return {
    databaseName,
    filePath,
    identityKey: setup.identityKey,
    log
  }
}
