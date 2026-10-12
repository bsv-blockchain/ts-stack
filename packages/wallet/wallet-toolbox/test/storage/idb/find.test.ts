import { _tu, TestSetup1 } from '../../utils/TestUtilsWalletStorage'
import { sdk, StorageProvider, StorageProviderOptions } from '../../../src/index.client'

import { StorageIdb } from '../../../src/storage/StorageIdb'
import { StorageKnex } from '../../../src/storage/StorageKnex'
import { knex } from 'knex'

import 'fake-indexeddb/auto'

describe('idb find tests', () => {
  jest.setTimeout(99999999)

  const chain: sdk.Chain = 'test'
  const _env = _tu.getEnv(chain)
  let setups: { setup: TestSetup1; storage: StorageProvider }[] = []

  beforeEach(async () => {
    const options: StorageProviderOptions = StorageProvider.createStorageBaseOptions(chain)
    const stores = [
      new StorageIdb(options),
      new StorageKnex({
        ...options,
        knex: knex({
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
          pool: { min: 1, max: 1 }
        })
      })
    ]
    setups = []
    for (const storage of stores) {
      await storage.dropAllData()
      await storage.migrate('idb find tests', '1'.repeat(64))
      await storage.makeAvailable()
      const setup = await _tu.createTestSetup1(storage)
      setups.push({ setup, storage })
    }
  })

  afterEach(async () => {
    for (const { storage } of setups) {
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
      // Empty arrays mean "no filter", as in StorageKnex and as every listCertificates caller relies on.
      expect(await storage.findCertificates({ partial: {}, certifiers: [], types: [] })).toHaveLength(3)
      expect(
        await storage.findCertificates({
          partial: {},
          certifiers: [],
          types: [setup.u1cert2.type]
        })
      ).toHaveLength(1)
      expect(
        await storage.findCertificates({ partial: {}, certifiers: [setup.u1cert1.certifier], types: [] })
      ).toHaveLength(1)
      expect(
        await storage.findCertificates({ partial: { userId: setup.u1.userId }, certifiers: [], types: [] })
      ).toHaveLength(3)
      expect(
        await storage.findCertificates({ partial: { userId: setup.u2.userId }, certifiers: [], types: [] })
      ).toEqual([])
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
    for (const { storage, setup } of setups) {
      const rows = await storage.findTransactions({ partial: {} })
      expect(rows).toHaveLength(3)
      expect(await storage.findTransactions({ partial: {}, status: [] })).toEqual(rows)
      const status = rows[0].status
      expect(await storage.findTransactions({ partial: {}, status: [status] })).toEqual(
        rows.filter(row => row.status === status)
      )
      // A nonempty status filter must still reject rows that do not match.
      expect(rows.every(row => row.status !== 'failed')).toBe(true)
      expect(await storage.findTransactions({ partial: {}, status: ['failed'] })).toEqual([])
      expect(await storage.findTransactions({ partial: { userId: setup.u1.userId }, status: [] })).toEqual(
        rows.filter(row => row.userId === setup.u1.userId)
      )
      expect(await storage.findTransactions({ partial: { userId: setup.u2.userId }, status: [] })).toEqual(
        rows.filter(row => row.userId === setup.u2.userId)
      )
      expect(await storage.findTransactions({ partial: { userId: 99 }, status: [] })).toEqual([])
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
    for (const { storage, setup } of setups) {
      const rows = await storage.findOutputTagMaps({ partial: {} })
      expect(rows).toHaveLength(3)
      expect(await storage.findOutputTagMaps({ partial: {}, tagIds: [] })).toEqual(rows)
      expect(await storage.findOutputTagMaps({ partial: {}, tagIds: [setup.u1tag1.outputTagId] })).toEqual(
        rows.filter(row => row.outputTagId === setup.u1tag1.outputTagId)
      )
      expect(await storage.findOutputTagMaps({ partial: {}, tagIds: [Number.MAX_SAFE_INTEGER] })).toEqual([])
      expect(await storage.findOutputTagMaps({ partial: { outputId: setup.u1tx1o0.outputId }, tagIds: [] })).toEqual(
        rows.filter(row => row.outputId === setup.u1tx1o0.outputId)
      )
      if (storage instanceof StorageIdb) {
        const owned: typeof rows = []
        await storage.filterOutputTagMaps(
          { partial: {}, tagIds: [] },
          row => {
            owned.push(row)
          },
          setup.u1.userId
        )
        expect(owned).toEqual(rows)
        const foreign: typeof rows = []
        await storage.filterOutputTagMaps(
          { partial: {}, tagIds: [] },
          row => {
            foreign.push(row)
          },
          setup.u2.userId
        )
        expect(foreign).toEqual([])
      }
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
