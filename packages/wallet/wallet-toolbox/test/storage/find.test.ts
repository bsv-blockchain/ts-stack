import { _tu, TestSetup1 } from '../utils/TestUtilsWalletStorage'
import { sdk, StorageProvider } from '../../src/index.client'
import { StorageKnex } from '../../src/storage/StorageKnex'

describe('find tests', () => {
  jest.setTimeout(99999999)

  const storages: StorageProvider[] = []
  const chain: sdk.Chain = 'test'
  const setups: { setup: TestSetup1; storage: StorageProvider }[] = []
  const env = _tu.getEnv(chain)

  beforeAll(async () => {
    const localSQLiteFile = await _tu.newTmpFile('storagefindtest.sqlite', false, false, false)
    const knexSQLite = _tu.createLocalSQLite(localSQLiteFile)
    storages.push(
      new StorageKnex({
        ...StorageKnex.defaultOptions(),
        chain,
        knex: knexSQLite
      })
    )

    if (env.runMySQL) {
      const knexMySQL = _tu.createLocalMySQL('storagefindtest')
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
      await storage.migrate('find tests', '1'.repeat(64))
      await storage.makeAvailable()
      setups.push({ storage, setup: await _tu.createTestSetup1(storage) })
    }
  })

  afterAll(async () => {
    for (const storage of storages) {
      await storage.destroy()
    }
  })

  test('0 find ProvenTx', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findProvenTxs({ partial: {} })).toHaveLength(1)
    }
  })

  test('1 find ProvenTxReq', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findProvenTxReqs({ partial: {} })).toHaveLength(2)
    }
  })

  test('2 find User', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findUsers({ partial: {} })).toHaveLength(2)
    }
  })

  test('3 find Certificate', async () => {
    for (const { storage, setup } of setups) {
      expect(await storage.findCertificates({ partial: {} })).toHaveLength(3)
      expect(
        await storage.findCertificates({
          partial: {},
          certifiers: [setup.u1cert1.certifier]
        })
      ).toHaveLength(1)
      expect(await storage.findCertificates({ partial: {}, certifiers: ['none'] })).toHaveLength(0)
      expect(
        await storage.findCertificates({
          partial: {},
          types: [setup.u1cert2.type]
        })
      ).toHaveLength(1)
      expect(await storage.findCertificates({ partial: {}, types: ['oblongata'] })).toHaveLength(0)
    }
  })

  test('4 find CertificateField', async () => {
    for (const { storage, setup } of setups) {
      expect(await storage.findCertificateFields({ partial: {} })).toHaveLength(3)
      expect(
        await storage.findCertificateFields({
          partial: { userId: setup.u1.userId }
        })
      ).toHaveLength(3)
      expect(
        await storage.findCertificateFields({
          partial: { userId: setup.u2.userId }
        })
      ).toHaveLength(0)
      expect(await storage.findCertificateFields({ partial: { userId: 99 } })).toHaveLength(0)
      expect(
        await storage.findCertificateFields({
          partial: { fieldName: 'name' }
        })
      ).toHaveLength(2)
      expect(await storage.findCertificateFields({ partial: { fieldName: 'bob' } })).toHaveLength(1)
      expect(
        await storage.findCertificateFields({
          partial: { fieldName: 'bob42' }
        })
      ).toHaveLength(0)
    }
  })

  test('5 find OutputBasket', async () => {
    for (const { storage, setup } of setups) {
      expect(await storage.findOutputBaskets({ partial: {} })).toHaveLength(3)
      expect(
        await storage.findOutputBaskets({
          partial: {},
          since: setup.u1.created_at
        })
      ).toHaveLength(3)
      expect(await storage.findOutputBaskets({ partial: {}, since: new Date() })).toHaveLength(0)
    }
  })

  test('6 find Transaction', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findTransactions({ partial: {} })).toHaveLength(3)
    }
  })

  test('7 find Commission', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findCommissions({ partial: {} })).toHaveLength(3)
    }
  })

  test('8 find Output', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findOutputs({ partial: {} })).toHaveLength(3)
    }
  })

  test('9 find OutputTag', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findOutputTags({ partial: {} })).toHaveLength(2)
    }
  })

  test('10 find OutputTagMap', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findOutputTagMaps({ partial: {} })).toHaveLength(3)
    }
  })

  test('11 find TxLabel', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findTxLabels({ partial: {} })).toHaveLength(3)
    }
  })

  test('12 find TxLabelMap', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findTxLabelMaps({ partial: {} })).toHaveLength(3)
    }
  })

  test('13 find MonitorEvent', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findMonitorEvents({ partial: {} })).toHaveLength(1)
    }
  })

  test('14 find SyncState', async () => {
    for (const { storage, setup: _setup } of setups) {
      expect(await storage.findSyncStates({ partial: {} })).toHaveLength(1)
    }
  })
})
