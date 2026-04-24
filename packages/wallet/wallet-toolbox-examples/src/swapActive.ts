import {
  sdk,
  Setup,
  SetupEnv,
  SetupWallet,
  StorageClient
} from '@bsv/wallet-toolbox'
import { runArgv2Function } from './runArgv2Function'

/**
 * @publicbody
 */
export async function swapActive(): Promise<void> {
  const env = Setup.getEnv('main')
  await swapActiveWalletClient(
    env,
    env.identityKey,
    'https://store.txs.systems'
  )
}

/**
 * @publicbody
 */
export async function swapActiveWalletClient(
  env: SetupEnv,
  identityKey: string,
  endpointUrl: string
): Promise<SetupWallet> {
  // Setup a wallet and storage manager without any storage providers.
  const setup = await Setup.createWallet({
    env,
    rootKeyHex: env.devKeys[identityKey]
  })

  // Create a StorageClient to both the default and the additional endpointUrl.
  const client1 = new StorageClient(setup.wallet, endpointUrl)
  const client2 = new StorageClient(
    setup.wallet,
    'https://storage.babbage.systems'
  )

  // Get the settings, which includes the storageIdentityKey, for each storage provider.
  const settings1 = await client1.makeAvailable()
  const settings2 = await client2.makeAvailable()
  await setup.storage.addWalletStorageProvider(client1)
  await setup.storage.addWalletStorageProvider(client2)

  // If one of the available storage providers matches the user's activeStorage,
  // this method will return that identityKey.
  // Otherwise, it will throw.
  // e.g. WERR_INVALID_PARAMETER: The storageIdentityKey parameter must be registered with this "WalletStorageManager".
  // 02c3bee1dd15c89937899897578b420e253c21d81de76b6365c2f5ad7ca743cf14 does not match any managed store.
  const activeStorageIdentity = setup.storage.getActiveStore()

  // To ensure the most recent active remains active use:
  // await setup.storage.setActive(activeStorageIdentity)
  //
  // But for this example, swap to the previously inactive storage provider.
  //
  if (activeStorageIdentity === settings1.storageIdentityKey) {
    await setup.storage.setActive(settings2.storageIdentityKey)
  } else if (activeStorageIdentity === settings2.storageIdentityKey) {
    await setup.storage.setActive(settings1.storageIdentityKey)
  } else {
    // This should never happen as the getActiveStore() will have thrown above.
    throw new Error(
      `${activeStorageIdentity} is not an available storage identity`
    )
  }
  return setup
}

runArgv2Function(module.exports)
