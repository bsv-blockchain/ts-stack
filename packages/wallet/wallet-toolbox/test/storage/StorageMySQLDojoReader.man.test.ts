// @ts-nocheck
import { _tu } from '../utils/TestUtilsWalletStorage'
import { entity, maxDate, sdk, StorageKnex, sync } from '../../src/index.all'
import { StorageMySQLDojoReader } from '../../src/storage/sync/StorageMySQLDojoReader'

import * as dotenv from 'dotenv'
dotenv.config()

describe('StorageMySQLDojoReader tests', () => {
  jest.setTimeout(99999999)

  const chain: sdk.Chain = 'test'
  const env = _tu.getEnv(chain)
  let reader: sdk.WalletStorageSyncReader
  let writer: StorageKnex

  beforeAll(async () => {
    const connection = JSON.parse(
      (chain === 'test' ? process.env.TEST_DOJO_CONNECTION : process.env.MAIN_DOJO_CONNECTION) || ''
    )
    const readerKnex = _tu.createMySQLFromConnection(connection)
    reader = new StorageMySQLDojoReader({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: readerKnex
    })

    const writerKnex = env.runMySQL
      ? _tu.createLocalMySQL('stagingdojotone')
      : _tu.createLocalSQLite(await _tu.newTmpFile('stagingdojotone', false, false, true))
    writer = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain,
      knex: writerKnex
    })
    await writer.dropAllData()
    await writer.migrate('stagingdojotone', '1'.repeat(64))
  })

  afterAll(async () => {
    await reader.destroy()
    await writer.destroy()
  })

  test('0', async () => {
    const readerSettings = await reader.getSettings()
    const writerSettings = await writer.getSettings()

    const identityKey = process.env.MY_TEST_IDENTITY || ''
    const ss = await EntitySyncState.fromStorage(writer, identityKey, readerSettings)

    for (;;) {
      const args = ss.makeRequestSyncChunkArgs(identityKey, writerSettings.storageIdentityKey)
      const chunk = await reader.getSyncChunk(args)
      const r = await ss.processRequestSyncChunkResult(writer, args, chunk)
      //console.log(`${r.maxUpdated_at} inserted ${r.inserts} updated ${r.updates}`)
      if (r.done) break
    }
  })
})
