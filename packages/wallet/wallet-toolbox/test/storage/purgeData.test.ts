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

  async function seedSpendableUtxo(storage: StorageProvider): Promise<string> {
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

  test('purgeFailed removes aged failed transactions, dependent rows, and terminal requests', async () => {
    for (const storage of storages) {
      const old = new Date(Date.now() - 1000 * 60 * 60 * 24)
      const { tx, user } = await _tu.insertTestTransaction(storage, undefined, false, {
        status: 'failed',
        updated_at: old
      })
      const output = await _tu.insertTestOutput(storage, tx, 0, 1000, undefined, false, {
        spendable: false
      })
      const tag = await _tu.insertTestOutputTag(storage, user)
      await _tu.insertTestOutputTagMap(storage, output, tag)
      const label = await _tu.insertTestTxLabel(storage, user)
      await _tu.insertTestTxLabelMap(storage, tx, label)
      await _tu.insertTestCommission(storage, tx)

      const invalid = await _tu.insertTestProvenTxReq(storage)
      await storage.updateProvenTxReq(invalid.provenTxReqId, {
        status: 'invalid',
        updated_at: old
      })
      const doubleSpend = await _tu.insertTestProvenTxReq(storage)
      await storage.updateProvenTxReq(doubleSpend.provenTxReqId, {
        status: 'doubleSpend',
        updated_at: old
      })

      const result = await storage.purgeData({
        purgeCompleted: false,
        purgeFailed: true,
        purgeFailedAge: 1,
        purgeSpent: false
      })

      expect(result.count).toBeGreaterThanOrEqual(7)
      expect(result.log).toContain('failed transactions deleted')
      expect(result.log).toContain('invalid proven_tx_reqs deleted')
      expect(result.log).toContain('doubleSpend proven_tx_reqs deleted')
      await expect(storage.findTransactions({ partial: { transactionId: tx.transactionId } })).resolves.toHaveLength(0)
    }
  })

  test('purgeSpent removes an aged completed transaction with no remaining spendable outputs', async () => {
    for (const storage of storages) {
      const { tx } = await _tu.insertTestTransaction(storage, undefined, false, {
        status: 'completed',
        txid: 'e'.repeat(64),
        updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24)
      })
      await _tu.insertTestOutput(storage, tx, 0, 1000, undefined, false, {
        spendable: false,
        txid: tx.txid
      })

      const result = await storage.purgeData(purgeSpentOnly)

      expect(result.count).toBeGreaterThanOrEqual(2)
      expect(result.log).toContain('spent outputs deleted')
      expect(result.log).toContain('spent transactions deleted')
      await expect(storage.findTransactions({ partial: { transactionId: tx.transactionId } })).resolves.toHaveLength(0)
    }
  })
})
