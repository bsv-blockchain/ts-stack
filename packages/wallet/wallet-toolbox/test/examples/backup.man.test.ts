import { Setup, SetupEnv, SetupWallet } from '../../src'
import dotenv from 'dotenv'
dotenv.config()

describe('backup example tests', () => {
  jest.setTimeout(99999999)

  test('0', () => {})
  if (Setup.noEnv('test')) return
  const env = Setup.getEnv('test')

  test('1 backup MY_TEST_IDENTITY', async () => {
    await backupWalletClient(env, process.env.MY_TEST_IDENTITY || '')
  })

  test('2 backup MY_TEST_IDENTITY2', async () => {
    await backupWalletClient(env, process.env.MY_TEST_IDENTITY2 || '')
  })
})

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
  await backupToSQLite(setup)
  await setup.wallet.destroy()
}

/**
 * @publicbody
 */
export async function backupToSQLite(setup: SetupWallet, filePath?: string, databaseName?: string): Promise<void> {
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
