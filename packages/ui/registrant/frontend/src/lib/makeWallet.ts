import {
  Wallet,
  WalletSigner,
  WalletStorageManager,
  StorageClient,
  Services,
  PrivilegedKeyManager
} from '@bsv/wallet-toolbox-client'
import { WalletClient, WalletInterface, KeyDeriver, PrivateKey } from '@bsv/sdk'

export default async function makeWallet(
  chain: 'test' | 'main' | 'local',
  privateKey: string,
  storageURL: string
): Promise<WalletInterface> {
  if (chain === 'local') {
    return new WalletClient()
  }
  const keyDeriver = new KeyDeriver(new PrivateKey(privateKey, 'hex'))
  const storageManager = new WalletStorageManager(keyDeriver.identityKey)
  const signer = new WalletSigner(chain, keyDeriver, storageManager)
  const services = new Services(chain)
  const wallet = new Wallet(
    signer,
    services,
    undefined,
    new PrivilegedKeyManager(reason =>
      Promise.resolve().then(() => {
        const key = window.prompt(
          `Privileged key requested. Privileged keys are not stored in local storage by WUI. You will need to provide it every time. Reason:\n\n${reason}\n\nPaste your privileged key in hex. If no value provided, a random key will be generated instead:`
        )
        if (!key) {
          return PrivateKey.fromRandom()
        } else {
          return new PrivateKey(key, 'hex')
        }
      })
    )
  )
  const client = new StorageClient(wallet, storageURL)
  await client.makeAvailable()
  await storageManager.addWalletStorageProvider(client)
  return wallet
}
