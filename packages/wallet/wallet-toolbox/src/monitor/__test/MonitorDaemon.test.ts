jest.mock('knex', () => ({
  knex: jest.fn(() => ({}))
}))

import { knex as makeKnex } from 'knex'
import { MonitorDaemon } from '../MonitorDaemon'
import { Services } from '../../services/Services'
import { StorageKnex } from '../../storage/StorageKnex'
import { WalletStorageManager } from '../../storage/WalletStorageManager'

describe('MonitorDaemon setup', () => {
  beforeEach(() => {
    jest.mocked(makeKnex).mockClear()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('derives SQLite and MySQL storage providers from connection settings', () => {
    const daemon = new MonitorDaemon({})
    const sqliteSetup: any = {
      chain: 'test',
      sqliteFilename: 'wallet.sqlite'
    }

    ;(daemon as any).configureKnex(sqliteSetup)

    expect(makeKnex).toHaveBeenCalledWith({
      client: 'better-sqlite3',
      connection: { filename: 'wallet.sqlite' },
      useNullAsDefault: true
    })
    expect(sqliteSetup.storageKnexOptions).toMatchObject({
      chain: 'test',
      feeModel: { model: 'sat/kb', value: 100 },
      commissionSatoshis: 0
    })
    expect(sqliteSetup.storageProvider).toBeInstanceOf(StorageKnex)

    const mysqlSetup: any = {
      chain: 'main',
      mySQLConnection: JSON.stringify({ host: 'database.example', database: 'wallet' })
    }

    ;(daemon as any).configureKnex(mysqlSetup)

    expect(makeKnex).toHaveBeenLastCalledWith({
      client: 'mysql2',
      connection: { host: 'database.example', database: 'wallet' },
      useNullAsDefault: true,
      pool: { min: 0, max: 7, idleTimeoutMillis: 15_000 }
    })
    expect(mysqlSetup.storageProvider).toBeInstanceOf(StorageKnex)
  })

  test('promotes an available storage provider into a storage manager', async () => {
    const daemon = new MonitorDaemon({})
    const storageProvider = {
      makeAvailable: jest.fn().mockResolvedValue(undefined),
      getSettings: jest.fn(() => ({ storageIdentityKey: 'identity-key' })),
      isStorageProvider: jest.fn(() => true)
    }
    const managerAvailable = jest.spyOn(WalletStorageManager.prototype, 'makeAvailable').mockResolvedValue({} as any)
    const setup: any = { storageProvider }

    await (daemon as any).configureStorage(setup)

    expect(storageProvider.makeAvailable).toHaveBeenCalledTimes(1)
    expect(setup.storageManager).toBeInstanceOf(WalletStorageManager)
    expect(managerAvailable).toHaveBeenCalledTimes(1)
    await expect((daemon as any).configureStorage({})).rejects.toThrow('storageManager')
  })

  test('validates explicit service options and installs chaintracks', () => {
    const daemon = new MonitorDaemon({})
    const wrongChain = Services.createDefaultOptions('main')

    expect(() => (daemon as any).configureServices({ chain: 'test', servicesOptions: wrongChain })).toThrow(
      'serviceOptions.chain'
    )

    const chaintracks = { marker: 'chaintracks' }
    const options = Services.createDefaultOptions('test')
    options.chaintracks = undefined
    const setup: any = {
      chain: 'test',
      chaintracks,
      servicesOptions: options
    }

    ;(daemon as any).configureServices(setup)

    expect(options.chaintracks).toBe(chaintracks)
    expect(setup.services).toBeInstanceOf(Services)
  })

  test('creates a default monitor around supplied storage and services', async () => {
    const storageManager = { setServices: jest.fn() }
    const services = new Services('test')
    const daemon = new MonitorDaemon({
      storageManager: storageManager as any,
      services
    })

    await daemon.createSetup()

    expect(daemon.setup?.chain).toBe('test')
    expect(storageManager.setServices).toHaveBeenCalledWith(services)
    expect(daemon.setup?.monitor).toBeDefined()

    const existingMonitor = daemon.setup?.monitor
    const preconfigured = new MonitorDaemon({ monitor: existingMonitor })
    await preconfigured.createSetup()
    expect(preconfigured.setup?.monitor).toBe(existingMonitor)
  })
})
