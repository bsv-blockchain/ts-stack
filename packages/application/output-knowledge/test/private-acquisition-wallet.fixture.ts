import { afterEach, jest } from '@jest/globals'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChainTracker } from '@bsv/sdk'
import { WalletToolboxAcquisitionFunding } from '../src/private/WalletToolboxAcquisitionFunding.js'
// Canonical integration uses the installed workspace development dependency.
// Wallet receipt ownership uses its public CJS exports and fresh local SQLite.
const requireWallet = createRequire(import.meta.url)
const { PrivateKey, CachedKeyDeriver } = requireWallet('@bsv/sdk') as typeof import('@bsv/sdk', {
  with: { 'resolution-mode': 'require' }
})
const { StorageKnex } = requireWallet(
  '@bsv/wallet-toolbox/out/src/storage/StorageKnex'
) as typeof import('@bsv/wallet-toolbox/out/src/storage/StorageKnex')
const { WalletStorageManager } = requireWallet(
  '@bsv/wallet-toolbox/out/src/storage/WalletStorageManager'
) as typeof import('@bsv/wallet-toolbox/out/src/storage/WalletStorageManager')
const { Services } = requireWallet(
  '@bsv/wallet-toolbox/out/src/services/Services'
) as typeof import('@bsv/wallet-toolbox/out/src/services/Services')
const { MockServices } = requireWallet(
  '@bsv/wallet-toolbox/out/src/mockchain/MockServices'
) as typeof import('@bsv/wallet-toolbox/out/src/mockchain/MockServices')
const { Wallet } = requireWallet(
  '@bsv/wallet-toolbox/out/src/Wallet'
) as typeof import('@bsv/wallet-toolbox/out/src/Wallet')
const { SQLiteFundingRecoveryStore } = requireWallet(
  '@bsv/wallet-toolbox/out/src/storage/fundingRecovery/SQLiteFundingRecoveryStore'
) as typeof import('@bsv/wallet-toolbox/out/src/storage/fundingRecovery/SQLiteFundingRecoveryStore')
const { RecoverableFundingController } = requireWallet(
  '@bsv/wallet-toolbox/out/src/signer/fundingRecovery/RecoverableFundingController'
) as typeof import('@bsv/wallet-toolbox/out/src/signer/fundingRecovery/RecoverableFundingController')
const { genesisHeader } = requireWallet(
  '@bsv/wallet-toolbox/out/src/services/chaintracker/chaintracks/util/blockHeaderUtilities'
) as typeof import('@bsv/wallet-toolbox/out/src/services/chaintracker/chaintracks/util/blockHeaderUtilities')
const installedWallet = createRequire(requireWallet.resolve('@bsv/wallet-toolbox/package.json'))
export type NativeStorage = InstanceType<typeof StorageKnex>
const openKnex = installedWallet('knex') as (config: {
  client: 'better-sqlite3'
  connection: { filename: string }
  useNullAsDefault: true
  pool: { min: number; max: number }
}) => ConstructorParameters<typeof StorageKnex>[0]['knex']

export { genesisHeader }
const cleanup = new Set<() => Promise<void>>()
afterEach(async () => {
  await Array.from(cleanup).reduce(
    (sequence, close) =>
      sequence.then(async () => {
        await close()
      }),
    Promise.resolve()
  )
  cleanup.clear()
})
/** Fresh disposable native wallet with explicitly installed synthetic-chain evidence. */
export async function acquisitionNativeWalletFixture(
  chain: { network: 'main' | 'test' | 'mock'; genesisHash: string },
  tracker: ChainTracker,
  rootKey = 83,
  managedChangePolicy?: { maxOutputsPerAction: number; migrationInputsPerAction: number },
  actionBatchMode: 'auto' | 'legacy' = 'legacy'
) {
  const directory = mkdtempSync(join(tmpdir(), 'acquisition-wallet-native-'))
  const opened = new Set<() => Promise<void>>()
  const broadcast: () => Promise<never> = jest.fn(() =>
    Promise.reject(new Error('Synthetic fixture cannot broadcast'))
  )
  async function open(create = false) {
    const knex = openKnex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.db') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    const closeKnex = async () => {
      await knex.destroy()
      opened.delete(closeKnex)
    }
    opened.add(closeKnex)
    const active = new StorageKnex({
      chain: chain.network,
      knex,
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 1 },
      ...(managedChangePolicy ? { managedChangePolicy: { ...managedChangePolicy } } : {})
    })
    if (create) await active.migrate('acquisition-native', 'synthetic-acquisition-wallet-storage')
    await active.makeAvailable()
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(rootKey)),
      storage = new WalletStorageManager(keyDeriver.identityKey, active)
    await storage.makeAvailable()
    const services = chain.network === 'mock' ? new MockServices(knex) : new Services(chain.network)
    services.getChainTracker = () => Promise.resolve(tracker)
    services.postBeef = broadcast
    const wallet = new Wallet({
      chain: chain.network,
      keyDeriver,
      storage,
      services,
      actionBatchMode
    })
    const recovery = await SQLiteFundingRecoveryStore[create ? 'install' : 'open'](active, chain)
    const controller = new RecoverableFundingController(wallet, recovery)
    const identities = {
      wallet: wallet.identityKey,
      storage: active.getSettings().storageIdentityKey
    }
    const bridge = new WalletToolboxAcquisitionFunding(controller, identities)
    const close = async () => {
      await wallet.destroy()
      opened.delete(close)
    }
    opened.delete(closeKnex)
    opened.add(close)
    return { active, wallet, controller, identities, bridge, services, close }
  }
  const close = async () => {
    await Array.from(opened).reduce(
      (sequence, closeWallet) =>
        sequence.then(async () => {
          await closeWallet()
        }),
      Promise.resolve()
    )
    rmSync(directory, { recursive: true, force: true })
    cleanup.delete(close)
  }
  cleanup.add(close)
  return { native: await open(true), open, close, broadcast }
}
