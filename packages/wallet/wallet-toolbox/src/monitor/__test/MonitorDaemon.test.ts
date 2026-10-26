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

  test('awaits storage-provider shutdown before clearing setup', async () => {
    let releaseDestroy: () => void = () => {}
    const destroy = jest.fn(
      () =>
        new Promise<void>(resolve => {
          releaseDestroy = resolve
        })
    )
    const daemon = new MonitorDaemon({})
    daemon.setup = {
      storageProvider: { destroy } as any
    }

    const completion = daemon.destroy()
    await Promise.resolve()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(daemon.setup).toBeDefined()

    releaseDestroy()
    await completion
    expect(daemon.setup).toBeUndefined()
  })

  test('starts subscriptions before tracker and task work, then stops cleanly', async () => {
    const order: string[] = []
    const monitor = {
      ready: Promise.resolve().then(() => order.push('ready')),
      startTasks: jest.fn(async () => {
        order.push('tasks')
      }),
      stopTasks: jest.fn(() => order.push('stop')),
      destroy: jest.fn(async () => order.push('destroy'))
    }
    const chaintracks = {
      startListening: jest.fn(async () => {
        order.push('chaintracks')
      })
    }
    const daemon = new MonitorDaemon({})
    daemon.setup = { monitor: monitor as any, chaintracks: chaintracks as any }

    await daemon.start()
    await daemon.stop()
    await daemon.destroy()

    expect(order).toEqual(['ready', 'chaintracks', 'tasks', 'stop', 'destroy'])
    expect(daemon.setup).toBeUndefined()
  })

  test('can restart after a transient tracker-listener startup failure', async () => {
    const failure = new Error('temporary listener failure')
    const monitor = {
      ready: Promise.resolve(),
      startTasks: jest.fn(async () => {}),
      stopTasks: jest.fn(),
      destroy: jest.fn(async () => {})
    }
    const chaintracks = {
      startListening: jest.fn<Promise<void>, []>().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    }
    const daemon = new MonitorDaemon({})
    daemon.setup = { monitor: monitor as any, chaintracks: chaintracks as any }

    await expect(daemon.start()).rejects.toBe(failure)
    expect(daemon.doneListening).toBeUndefined()
    expect(daemon.doneTasks).toBeUndefined()
    await expect(daemon.start()).resolves.toBeUndefined()
    await daemon.stop()
  })

  test('destroys monitor resources before storage and continues cleanup after failure', async () => {
    const order: string[] = []
    const monitorFailure = new Error('monitor cleanup failed')
    const daemon = new MonitorDaemon({})
    daemon.setup = {
      monitor: {
        destroy: jest.fn(async () => {
          order.push('monitor')
          throw monitorFailure
        })
      } as any,
      storageProvider: {
        destroy: jest.fn(async () => {
          order.push('storage')
        })
      } as any
    }

    await expect(daemon.destroy()).rejects.toThrow('monitor cleanup failed')
    expect(order).toEqual(['monitor', 'storage'])
    expect(daemon.setup).toBeUndefined()
  })
})
