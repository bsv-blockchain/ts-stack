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
dotenv.config()

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

  constructor (
    public args: MonitorDaemonSetup,
    public noRunTasks?: boolean
  ) {
    /* */
  }

  private configureKnex (setup: MonitorDaemonSetup): void {
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

  private async configureStorage (setup: MonitorDaemonSetup): Promise<void> {
    if (setup.storageProvider != null) {
      await setup.storageProvider.makeAvailable()
      const settings = setup.storageProvider.getSettings()
      setup.storageManager = new WalletStorageManager(
        settings.storageIdentityKey,
        setup.storageProvider
      )
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

  private configureServices (setup: MonitorDaemonSetup): void {
    if (setup.servicesOptions != null) {
      if (setup.servicesOptions.chain !== setup.chain) {
        throw new WERR_INVALID_PARAMETER('serviceOptions.chain', 'same as args.chain')
      }
      setup.servicesOptions.chaintracks ??= setup.chaintracks
      setup.services = new Services(setup.servicesOptions)
    }
    setup.services ??= new Services(setup.chain ?? 'test')
  }

  async createSetup (): Promise<void> {
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

  async start (): Promise<void> {
    if (this.setup == null) await this.createSetup()
    if ((this.setup?.monitor) == null) throw new WERR_INTERNAL('createSetup failed to initialize setup')

    const { monitor } = this.setup

    if (this.noRunTasks !== true) {
      console.log('\n\nRunning startTasks\n\n')
      this.doneTasks = monitor.startTasks()
    }
  }

  async stop (): Promise<void> {
    console.log('start of stop')

    if ((this.setup == null) || ((this.doneTasks == null) && this.noRunTasks !== true) || (this.doneListening == null)) { throw new WERR_INTERNAL('call start or createSetup first') }

    const { monitor } = this.setup

    ;(monitor as Monitor).stopTasks()

    if (this.doneTasks != null) await this.doneTasks
    this.doneTasks = undefined
    await this.doneListening
    this.doneListening = undefined
  }

  async destroy (): Promise<void> {
    if (this.setup == null) return
    if ((this.doneTasks != null) || (this.doneListening != null)) await this.stop()
    if (this.setup.storageProvider != null) void this.setup.storageProvider.destroy()
    this.setup = undefined
  }

  async runDaemon (): Promise<void> {
    this.stopDaemon = false
    for (;;) {
      try {
        await this.start()

        while (!this.stopDaemon) {
          await wait(10 * 1000)
        }

        console.log('stopping')

        await this.stop()

        console.log('cleanup')

        await this.destroy()

        console.log('done')
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        console.log(`\n\nrunWatchman Main Error Handler\n\ncode: ${e.code}\nDescription: ${e.description}\n\n\n`)
      }
    }
  }
}
