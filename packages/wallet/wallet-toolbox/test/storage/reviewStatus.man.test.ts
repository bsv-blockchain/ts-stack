import { _tu, setLogging } from '../utils/TestUtilsWalletStorage'
import { sdk, StorageKnex, StorageProvider, verifyOne } from '../../src/index.all'
import type { ProvenTxReqStatus } from '../../src/sdk/types'

setLogging(false)

describe('reviewStatus tests', () => {
  jest.setTimeout(99999999)

  const chain: sdk.Chain = 'test'
  const env = _tu.getEnvFlags(chain)
  const failedTxid = 'a'.repeat(64)
  const blockingReqStatuses: ProvenTxReqStatus[] = [
    'sending',
    'unsent',
    'nosend',
    'unknown',
    'nonfinal',
    'unprocessed',
    'unmined',
    'callback',
    'unconfirmed',
    'completed',
    'unfail'
  ]

  let storages: StorageProvider[]

  beforeEach(async () => {
    storages = []
    const testSlug = (expect.getState().currentTestName || 'reviewStatus').replace(/[^a-zA-Z0-9_]/g, '_')
    const databaseName = `reviewStatus_${testSlug.slice(-40)}`

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
      await storage.migrate('reviewStatus tests', '1'.repeat(64))
      await storage.makeAvailable()
    }
  })

  afterEach(async () => {
    for (const storage of storages) {
      await storage.destroy()
    }
  })

  async function seedFailedSpend (storage: StorageProvider, reqStatus?: ProvenTxReqStatus) {
    const { tx: fundingTx, user } = await _tu.insertTestTransaction(storage, undefined, false, {
      status: 'completed',
      txid: 'b'.repeat(64)
    })
    const { tx: failedTx } = await _tu.insertTestTransaction(storage, user, false, {
      status: 'failed',
      txid: failedTxid
    })
    const spentOutput = await _tu.insertTestOutput(storage, fundingTx, 0, 1000, undefined, false, {
      spendable: false,
      spentBy: failedTx.transactionId
    })

    if (reqStatus != null) {
      const req = await _tu.insertTestProvenTxReq(storage, failedTxid)
      await storage.updateProvenTxReq(req.provenTxReqId, { status: reqStatus })
    }

    return { failedTx, spentOutput }
  }

  test.each(blockingReqStatuses)('does not restore failed transaction inputs while req status is %s', async status => {
    for (const storage of storages) {
      const { failedTx, spentOutput } = await seedFailedSpend(storage, status)

      await storage.reviewStatus({ agedLimit: new Date() })

      const output = verifyOne(await storage.findOutputs({ partial: { outputId: spentOutput.outputId } }))
      expect(output.spendable).toBe(false)
      expect(output.spentBy).toBe(failedTx.transactionId)
    }
  })

  test.each([
    { label: 'no req', status: undefined },
    { label: 'invalid req', status: 'invalid' as ProvenTxReqStatus },
    { label: 'doubleSpend req', status: 'doubleSpend' as ProvenTxReqStatus }
  ])('restores failed transaction inputs with $label', async ({ status }) => {
    for (const storage of storages) {
      const { spentOutput } = await seedFailedSpend(storage, status)

      await storage.reviewStatus({ agedLimit: new Date() })

      const output = verifyOne(await storage.findOutputs({ partial: { outputId: spentOutput.outputId } }))
      expect(output.spendable).toBe(true)
      expect(output.spentBy).toBeUndefined()
    }
  })
})
