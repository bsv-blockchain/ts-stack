import { sdk, Setup, SetupEnv, SetupWallet } from '@bsv/wallet-toolbox'
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
export async function backupWalletClient(
  env: SetupEnv,
  identityKey: string
): Promise<void> {
  const setup = await Setup.createWalletClient({
    env,
    rootKeyHex: env.devKeys[identityKey]
  })
  await backupToSQLite(setup)
  await setup.wallet.destroy()
}

/**
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

  const backup = await Setup.createStorageKnex({
    env,
    knex: Setup.createSQLiteKnex(filePath),
    databaseName,
    rootKeyHex: setup.keyDeriver.rootKey.toHex()
  })

  await setup.storage.addWalletStorageProvider(backup)

  await setup.storage.updateBackups()
}

runArgv2Function(module.exports)
