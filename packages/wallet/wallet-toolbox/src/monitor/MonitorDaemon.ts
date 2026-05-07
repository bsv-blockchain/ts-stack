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
import { Chaintracks } from '../services/chaintracker/chaintracks/Chaintracks'
dotenv.config()

const mainDojoConnection = process.env.MAIN_DOJO_CONNECTION || ''
const testDojoConnection = process.env.TEST_DOJO_CONNECTION || ''

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
  chaintracks?: Chaintracks
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

  async createSetup (): Promise<void> {
    this.setup = { ...this.args }
    const a = this.setup

    if (a.monitor == null) {
      a.chain ||= 'test'

      if (a.sqliteFilename) {
        a.knexConfig = {
          client: 'better-sqlite3',
          connection: { filename: a.sqliteFilename },
          useNullAsDefault: true
        }
      }

      if (a.mySQLConnection) {
        a.knexConfig = {
          client: 'mysql2',
          connection: JSON.parse(a.mySQLConnection),
          useNullAsDefault: true,
          pool: { min: 0, max: 7, idleTimeoutMillis: 15000 }
        }
      }

      if (a.knexConfig != null) {
        a.knex = makeKnex(a.knexConfig)
      }

      if (a.knex != null) {
        a.storageKnexOptions = {
          knex: a.knex,
          chain: a.chain,
          feeModel: { model: 'sat/kb', value: 1 },
          commissionSatoshis: 0
        }
      }

      if (a.storageKnexOptions != null) {
        a.storageProvider = new StorageKnex(a.storageKnexOptions)
      }

      if (a.storageProvider != null) {
        await a.storageProvider.makeAvailable()
        const settings = a.storageProvider.getSettings()
        a.storageManager = new WalletStorageManager(settings.storageIdentityKey, a.storageProvider)
        await a.storageManager.makeAvailable()
      } else if (a.storageManager == null) {
        throw new WERR_INVALID_PARAMETER(
          'storageManager',
          'valid or one of mySQLConnection, knexConfig, knex, storageKnexOptions, or storageProvider'
        )
      }

      if (a.servicesOptions != null) {
        if (a.servicesOptions.chain != a.chain) { throw new WERR_INVALID_PARAMETER('serviceOptions.chain', 'same as args.chain') }
        a.servicesOptions.chaintracks ??= a.chaintracks
        a.services = new Services(a.servicesOptions)
      }

      a.services ??= new Services(a.chain)

      a.storageManager.setServices(a.services)

      const monitorOptions = Monitor.createDefaultWalletMonitorOptions(
        a.chain,
        a.storageManager,
        a.services,
        a.chaintracks,
        a.startupTaskMode || 'multiuser'
      )
      a.monitor = new Monitor(monitorOptions)
    }
  }

  async start (): Promise<void> {
    if (this.setup == null) await this.createSetup()
    if ((this.setup?.monitor) == null) throw new WERR_INTERNAL('createSetup failed to initialize setup')

    const { monitor } = this.setup

    if (!this.noRunTasks) {
      console.log('\n\nRunning startTasks\n\n')
      this.doneTasks = monitor.startTasks()
    }
  }

  async stop (): Promise<void> {
    console.log('start of stop')

    if ((this.setup == null) || ((this.doneTasks == null) && !this.noRunTasks) || (this.doneListening == null)) { throw new WERR_INTERNAL('call start or createSetup first') }

    const { monitor } = this.setup

    monitor!.stopTasks()

    if (this.doneTasks != null) await this.doneTasks
    this.doneTasks = undefined
    await this.doneListening
    this.doneListening = undefined
  }

  async destroy (): Promise<void> {
    if (this.setup == null) return
    if (this.doneTasks || (this.doneListening != null)) await this.stop()
    if (this.setup.storageProvider != null) this.setup.storageProvider.destroy()
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
