import type { Beef } from '@bsv/sdk'
import { _tu, setLogging } from '../utils/TestUtilsWalletStorage'
import { sdk, StorageKnex, StorageProvider } from '../../src/index.all'
import type { PurgeParams } from '../../src/sdk/WalletStorage.interfaces'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../../src/sdk/WERR_errors'

setLogging(false)

describe('purgeData tests', () => {
  jest.setTimeout(99999999)

  const chain: sdk.Chain = 'test'
  const env = _tu.getEnvFlags(chain)
  const purgeSpentOnly: PurgeParams = {
    purgeCompleted: false,
    purgeFailed: false,
    purgeSpent: true,
    purgeSpentAge: 1
  }

  let storages: StorageProvider[]

  beforeEach(async () => {
    storages = []
    const testSlug = (expect.getState().currentTestName || 'purgeData').replace(/[^a-zA-Z0-9_]/g, '_')
    const databaseName = `purgeData_${testSlug.slice(-40)}`

    const localSQLiteFile = await _tu.newTmpFile(`${databaseName}.sqlite`, false, false, false)
    storages.push(
      new StorageKnex({
        ...StorageKnex.defaultOptions(),
        chain,
        knex: _tu.createLocalSQLite(localSQLiteFile)
      })
    )

    if (env.runMySQL) {
      storages.push(
        new StorageKnex({
          ...StorageKnex.defaultOptions(),
          chain,
          knex: _tu.createLocalMySQL(`${databaseName}.mysql`)
        })
      )
    }

    for (const storage of storages) {
      await storage.dropAllData()
      await storage.migrate('purgeData tests', '1'.repeat(64))
      await storage.makeAvailable()
    }
  })

  afterEach(async () => {
    for (const storage of storages) {
      await storage.destroy()
    }
  })

  async function seedSpendableUtxo (storage: StorageProvider): Promise<string> {
    const txid = 'c'.repeat(64)
    const { tx } = await _tu.insertTestTransaction(storage, undefined, false, {
      status: 'completed',
      txid,
      updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24)
    })
    await _tu.insertTestOutput(storage, tx, 0, 1000, undefined, false, {
      spendable: true,
      txid
    })
    return txid
  }

  test('purgeSpent ignores missing local beef for the spendable utxo txid', async () => {
    for (const storage of storages) {
      const txid = await seedSpendableUtxo(storage)
      storage.getBeefForTransaction = jest.fn(async (requestTxid: string): Promise<Beef> => {
        throw new WERR_INVALID_PARAMETER(`txid ${requestTxid}`, `valid transaction on chain ${storage.chain}`)
      }) as StorageProvider['getBeefForTransaction']

      await expect(storage.purgeData(purgeSpentOnly)).resolves.toBeDefined()
      expect(storage.getBeefForTransaction).toHaveBeenCalledWith(
        txid,
        expect.objectContaining({ ignoreServices: true })
      )
    }
  })

  test('purgeSpent ignores missing local beef for a dependency txid', async () => {
    for (const storage of storages) {
      await seedSpendableUtxo(storage)
      storage.getBeefForTransaction = jest.fn(async (): Promise<Beef> => {
        throw new WERR_INVALID_PARAMETER('txid', `known to storage. ${'d'.repeat(64)} is not known.`)
      }) as StorageProvider['getBeefForTransaction']

      await expect(storage.purgeData(purgeSpentOnly)).resolves.toBeDefined()
    }
  })

  test('purgeSpent rethrows unexpected getBeefForTransaction errors', async () => {
    for (const storage of storages) {
      await seedSpendableUtxo(storage)
      storage.getBeefForTransaction = jest.fn(async (): Promise<Beef> => {
        throw new WERR_INTERNAL('simulated local storage failure')
      }) as StorageProvider['getBeefForTransaction']

      await expect(storage.purgeData(purgeSpentOnly)).rejects.toThrow('simulated local storage failure')
    }
  })
})
