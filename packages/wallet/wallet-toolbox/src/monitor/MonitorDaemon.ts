import { Knex, knex as makeKnex } from 'knex'

import dotenv from 'dotenv'
import { Chain } from '../sdk/types'
import { StorageKnex, StorageKnexOptions } from '../storage/StorageKnex'
import { StorageProvider } from '../storage/StorageProvider'
import { WalletStorageManager } from '../storage/WalletStorageManager'
import { WalletServicesOptions } from '../sdk/WalletServices.interfaces'
import { Services } from '../services/Services'
import { Monitor, MonitorStartupTaskMode } from './Monitor'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { wait } from '../utility/utilityHelpers'
import { WalletError } from '../sdk/WalletError'
import { ChaintracksClientApi } from '../services/chaintracker/chaintracks/Api/ChaintracksClientApi'
import { safeDiagnostic } from '../services/chaintracker/chaintracks/util/safeDiagnostic'
dotenv.config({ quiet: true })

export interface MonitorDaemonSetup {
  chain?: Chain
  sqliteFilename?: string
  mySQLConnection?: string
  knexConfig?: Knex.Config
  knex?: Knex<any, any[]>
  storageKnexOptions?: StorageKnexOptions
  storageProvider?: StorageProvider
  storageManager?: WalletStorageManager
  servicesOptions?: WalletServicesOptions
  services?: Services
  monitor?: Monitor
  chaintracks?: ChaintracksClientApi
  startupTaskMode?: MonitorStartupTaskMode
}

export class MonitorDaemon {
  setup?: MonitorDaemonSetup
  doneListening?: Promise<void>
  doneTasks?: Promise<void>
  stopDaemon: boolean = false

  constructor(
    public args: MonitorDaemonSetup,
    public noRunTasks?: boolean
  ) {
    /* */
  }

  private configureKnex(setup: MonitorDaemonSetup): void {
    if (setup.sqliteFilename != null && setup.sqliteFilename !== '') {
      setup.knexConfig = {
        client: 'better-sqlite3',
        connection: { filename: setup.sqliteFilename },
        useNullAsDefault: true
      }
    }
    if (setup.mySQLConnection != null && setup.mySQLConnection !== '') {
      setup.knexConfig = {
        client: 'mysql2',
        connection: JSON.parse(setup.mySQLConnection),
        useNullAsDefault: true,
        pool: { min: 0, max: 7, idleTimeoutMillis: 15000 }
      }
    }
    if (setup.knexConfig != null) setup.knex = makeKnex(setup.knexConfig)
    if (setup.knex != null) {
      setup.storageKnexOptions = {
        knex: setup.knex,
        chain: setup.chain!,
        feeModel: { model: 'sat/kb', value: 100 },
        commissionSatoshis: 0
      }
    }
    if (setup.storageKnexOptions != null) {
      setup.storageProvider = new StorageKnex(setup.storageKnexOptions)
    }
  }

  private async configureStorage(setup: MonitorDaemonSetup): Promise<void> {
    if (setup.storageProvider != null) {
      await setup.storageProvider.makeAvailable()
      const settings = setup.storageProvider.getSettings()
      setup.storageManager = new WalletStorageManager(settings.storageIdentityKey, setup.storageProvider)
      await setup.storageManager.makeAvailable()
      return
    }
    if (setup.storageManager == null) {
      throw new WERR_INVALID_PARAMETER(
        'storageManager',
        'valid or one of mySQLConnection, knexConfig, knex, storageKnexOptions, or storageProvider'
      )
    }
  }

  private configureServices(setup: MonitorDaemonSetup): void {
    if (setup.servicesOptions != null) {
      if (setup.servicesOptions.chain !== setup.chain) {
        throw new WERR_INVALID_PARAMETER('serviceOptions.chain', 'same as args.chain')
      }
      setup.servicesOptions.chaintracks ??= setup.chaintracks
      setup.services = new Services(setup.servicesOptions)
    }
    setup.services ??= new Services(setup.chain ?? 'test')
  }

  async createSetup(): Promise<void> {
    this.setup = { ...this.args }
    const a = this.setup

    if (a.monitor != null) return
    a.chain ||= 'test'
    this.configureKnex(a)
    await this.configureStorage(a)
    this.configureServices(a)
    a.storageManager!.setServices(a.services!)
    const monitorOptions = Monitor.createDefaultWalletMonitorOptions(
      a.chain,
      a.storageManager!,
      a.services!,
      a.chaintracks,
      a.startupTaskMode ?? 'multiuser'
    )
    a.monitor = new Monitor(monitorOptions)
  }

  async start(): Promise<void> {
    if (this.doneListening != null || this.doneTasks != null) {
      throw new WERR_INTERNAL('monitor daemon is already started')
    }
    if (this.setup == null) await this.createSetup()
    if (this.setup?.monitor == null) throw new WERR_INTERNAL('createSetup failed to initialize setup')

    const { monitor, chaintracks } = this.setup
    await monitor.ready
    this.doneListening = chaintracks?.startListening() ?? Promise.resolve()
    try {
      await this.doneListening
    } catch (error) {
      this.doneListening = undefined
      this.doneTasks = undefined
      throw error
    }

    if (this.noRunTasks !== true) {
      this.doneTasks = monitor.startTasks()
    }
  }

  async stop(): Promise<void> {
    if (this.setup == null || (this.doneTasks == null && this.noRunTasks !== true) || this.doneListening == null) {
      throw new WERR_INTERNAL('call start or createSetup first')
    }

    const { monitor } = this.setup
    if (monitor == null) throw new WERR_INTERNAL('monitor daemon setup has no monitor')
    monitor.stopTasks()
    const results = await Promise.allSettled([this.doneTasks, this.doneListening].filter(p => p != null))
    this.doneTasks = undefined
    this.doneListening = undefined
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure != null) throw WalletError.fromUnknown(failure.reason)
  }

  async destroy(): Promise<void> {
    if (this.setup == null) return
    const setup = this.setup
    const failures: unknown[] = []
    if (this.doneTasks != null || this.doneListening != null) {
      try {
        await this.stop()
      } catch (error) {
        failures.push(error)
      } finally {
        this.doneTasks = undefined
        this.doneListening = undefined
      }
    }
    if (setup.monitor != null) {
      try {
        await setup.monitor.destroy()
      } catch (error) {
        failures.push(error)
      }
    }
    if (setup.storageProvider != null) {
      try {
        await setup.storageProvider.destroy()
      } catch (error) {
        failures.push(error)
      }
    }
    this.setup = undefined
    if (failures.length > 0) throw WalletError.fromUnknown(failures[0])
  }

  async runDaemon(): Promise<void> {
    this.stopDaemon = false
    while (!this.stopDaemon) {
      try {
        await this.start()

        while (!this.stopDaemon) {
          await wait(10 * 1000)
        }
        await this.stop()
        await this.destroy()
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        console.log(`monitor daemon error ${safeDiagnostic(e.code, 64)} ${safeDiagnostic(e.description)}`)
        try {
          await this.destroy()
        } catch (cleanupError) {
          console.log(`monitor daemon cleanup error ${safeDiagnostic(cleanupError)}`)
        }
        if (!this.stopDaemon) await wait(5000)
      }
    }
  }
}
