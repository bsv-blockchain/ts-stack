import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { randomBytesHex, sdk, StorageProvider, TableProvenTx } from '../../index.client'
import { StorageKnex } from '../StorageKnex'

describe('findStaleMerkleRootsKnex test', () => {
  jest.setTimeout(99999999)

  const storages: StorageProvider[] = []
  const chain: sdk.Chain = 'test'
  const env = _tu.getEnv(chain)

  beforeAll(async () => {
    const localSQLiteFile = await _tu.newTmpFile('findstalemerkleroots.sqlite', false, false, false)
    const knexSQLite = _tu.createLocalSQLite(localSQLiteFile)

    storages.push(
      new StorageKnex({
        ...StorageKnex.defaultOptions(),
        chain,
        knex: knexSQLite
      })
    )

    if (env.runMySQL) {
      const knexMySQL = _tu.createLocalMySQL('findstalemerkleroots')
      storages.push(
        new StorageKnex({
          ...StorageKnex.defaultOptions(),
          chain,
          knex: knexMySQL
        })
      )
    }

    for (const storage of storages) {
      await storage.dropAllData()
      await storage.migrate('findStaleMerkleRoots tests', '1'.repeat(64))
      await storage.makeAvailable()
    }
  })

  afterAll(async () => {
    for (const storage of storages) {
      await storage.destroy()
    }
  })

  test('0 returns distinct stale merkle roots for the target height', async () => {
    for (const storage of storages) {
      await storage.dropAllData()
      await storage.migrate('findStaleMerkleRoots test reset', '1'.repeat(64))
      await storage.makeAvailable()

      const height = 777
      const currentMerkleRoot = 'aa'.repeat(32)

      await storage.insertProvenTx(makeProvenTx(1, height, currentMerkleRoot))
      await storage.insertProvenTx(makeProvenTx(2, height, 'bb'.repeat(32)))
      await storage.insertProvenTx(makeProvenTx(3, height, 'bb'.repeat(32)))
      await storage.insertProvenTx(makeProvenTx(4, height, 'cc'.repeat(32)))
      await storage.insertProvenTx(makeProvenTx(5, height + 1, 'dd'.repeat(32)))

      const roots = await storage.findStaleMerkleRoots({
        height,
        merkleRoot: currentMerkleRoot
      })

      expect(roots.sort()).toEqual(['bb'.repeat(32), 'cc'.repeat(32)])
    }
  })
})

function makeProvenTx(provenTxId: number, height: number, merkleRoot: string): TableProvenTx {
  const now = new Date()
  return {
    created_at: now,
    updated_at: now,
    provenTxId: 0,
    txid: randomBytesHex(32),
    height,
    index: provenTxId,
    merklePath: [1, 2, 3, 4],
    rawTx: [5, 6, 7],
    blockHash: randomBytesHex(32),
    merkleRoot
  }
}
