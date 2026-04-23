import express from 'express'
import bodyParser from 'body-parser'
import { Engine, KnexStorage, LookupService, TopicManager, KnexStorageMigrations, Advertiser } from '@bsv/overlay'
import {
  ARC,
  ChainTracker,
  MerklePath,
  STEAK,
  TaggedBEEF,
  WhatsOnChain,
  Broadcaster,
  OverlayBroadcastFacilitator,
  HTTPSOverlayBroadcastFacilitator,
  DEFAULT_TESTNET_SLAP_TRACKERS,
  DEFAULT_SLAP_TRACKERS,
  Utils,
  Beef,
  Transaction,
  PrivateKey,
  KeyDeriver,
  WalletInterface
} from '@bsv/sdk'
import Knex from 'knex'
import { MongoClient, Db } from 'mongodb'
import makeUserInterface, { type UIConfig } from './makeUserInterface.js'
import * as DiscoveryServices from '@bsv/overlay-discovery-services'
import chalk from 'chalk'
import util from 'util'
import { v4 as uuidv4 } from 'uuid'
import { JanitorService, type JanitorReport } from './JanitorService.js'
import { BanService } from './BanService.js'
import { BanAwareLookupWrapper } from './BanAwareLookupWrapper.js'
import { Wallet, WalletSigner, WalletStorageManager, Services } from '@bsv/wallet-toolbox-client'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'

/**
 * Knex database migration.
 */
interface Migration {
  name?: string
  up: (knex: Knex.Knex) => Promise<void>
  down?: (knex: Knex.Knex) => Promise<void>
}

/**
 * In-memory migration source for Knex migrations.
 * Allows running migrations defined in code rather than files.
 */
class InMemoryMigrationSource implements Knex.Knex.MigrationSource<Migration> {
  constructor (private readonly migrations: Migration[]) { }

  /**
   * Gets the list of migrations.
   * @param loadExtensions - Array of file extensions to filter by (not used here)
   * @returns Promise resolving to the array of migrations
   */
  async getMigrations (loadExtensions: readonly string[]): Promise<Migration[]> {
    return this.migrations
  }

  /**
   * Gets the name of a migration.
   * @param migration - The migration object
   * @returns The name of the migration
   */
  getMigrationName (migration: Migration): string {
    return typeof migration.name === 'string' ? migration.name : `Migration at index ${this.migrations.indexOf(migration)}`
  }

  /**
   * Gets the migration object.
   * @param migration - The migration object
   * @returns Promise resolving to the migration object
   */
  async getMigration (migration: Migration): Promise<Knex.Knex.Migration> {
    return await Promise.resolve(migration)
  }
}

/**
 * Configuration options that map to Engine constructor parameters.
 */
export interface EngineConfig {
  chainTracker?: ChainTracker | 'scripts only'
  shipTrackers?: string[]
  slapTrackers?: string[]
  broadcaster?: Broadcaster
  advertiser?: Advertiser
  syncConfiguration?: Record<string, string[] | 'SHIP' | false>
  logTime?: boolean
  logPrefix?: string
  throwOnBroadcastFailure?: boolean
  overlayBroadcastFacilitator?: OverlayBroadcastFacilitator
  suppressDefaultSyncAdvertisements?: boolean
}

export type HealthStatus = 'ok' | 'degraded' | 'error'

export interface HealthCheckResult {
  name: string
  scope: 'live' | 'ready'
  status: HealthStatus
  critical: boolean
  message?: string
  details?: Record<string, any>
  durationMs: number
}

export type HealthCheckHandler = () => Promise<Omit<HealthCheckResult, 'name' | 'scope' | 'critical' | 'durationMs'> | void> | Omit<HealthCheckResult, 'name' | 'scope' | 'critical' | 'durationMs'> | void

export interface HealthCheckDefinition {
  name: string
  scope?: 'live' | 'ready'
  critical?: boolean
  handler: HealthCheckHandler
}

export interface HealthConfig {
  includeDetails: boolean
  timeoutMs: number
  contextProvider?: () => Promise<Record<string, any> | undefined> | Record<string, any> | undefined
}

export interface HealthReport {
  status: HealthStatus
  live: boolean
  ready: boolean
  service: {
    name: string
    advertisableFQDN: string
    port: number
    network: 'main' | 'test'
    startedAt?: string
    uptimeMs: number
    topicManagerCount: number
    lookupServiceCount: number
  }
  checks: HealthCheckResult[]
  context?: Record<string, any>
}

/**
 * OverlayExpress class provides an Express-based server for hosting Overlay Services.
 * It allows configuration of various components like databases, topic managers, and lookup services.
 * It encapsulates an Express application and provides methods to start the server.
 */
export default class OverlayExpress {
  // Express application
  app: express.Application

  // Server port
  port: number = 3000

  // Logger (defaults to console)
  logger: typeof console = console

  // Knex (SQL) database
  knex?: Knex.Knex

  // Knex migrations to run
  migrationsToRun: Migration[] = []

  // MongoDB database
  mongoDb?: Db

  // MongoDB client retained for health checks
  mongoClient?: MongoClient

  // Network ('main' or 'test')
  network: 'main' | 'test' = 'main'

  // If no custom ChainTracker is configured, default is a WhatsOnChain instance
  // (We keep a property for it, so we can pass it to Engine)
  chainTracker: ChainTracker | 'scripts only' = new WhatsOnChain(this.network)

  // The Overlay Engine
  engine?: Engine

  // Configured Topic Managers
  managers: Record<string, TopicManager> = {}

  // Configured Lookup Services
  services: Record<string, LookupService> = {}

  // Enable GASP Sync
  // (We allow an on/off toggle, but also can do advanced custom sync config below)
  enableGASPSync: boolean = true

  // ARC API Key
  arcApiKey: string | undefined = undefined

  // Verbose request logging
  verboseRequestLogging: boolean = false

  // Web UI configuration
  webUIConfig: UIConfig = {}

  // Additional advanced engine config (these map to Engine constructor parameters).
  // Default to undefined or default values that are used in the Engine if not specified.
  engineConfig: EngineConfig = {}

  // The administrative Bearer token used for the admin routes.
  // If not passed in, we'll generate a random one.
  private readonly adminToken: string

  // Configuration for the janitor service
  janitorConfig: {
    requestTimeoutMs: number
    hostDownRevokeScore: number
    autoBanOnRemoval: boolean
  } = {
      requestTimeoutMs: 10000, // 10 seconds
      hostDownRevokeScore: 3,
      autoBanOnRemoval: true
    }

  // Ban service for persistent domain/outpoint blocking
  banService?: BanService

  // Admin identity key for wallet-based admin detection on the frontend
  adminIdentityKey?: string

  // Server-side wallet (WalletInterface) used for BSV mutual authentication
  serverWallet?: WalletInterface

  // Server start time for uptime tracking
  private startTime?: Date

  // Health endpoint configuration
  healthConfig: HealthConfig = {
    includeDetails: true,
    timeoutMs: 5000
  }

  // Extra application-specific health checks
  healthChecks: HealthCheckDefinition[] = []

  // Lifecycle marker for readiness/liveness reporting
  isListening: boolean = false

  /**
   * Constructs an instance of OverlayExpress.
   * @param name - The name of the service
   * @param privateKey - Private key used for signing advertisements
   * @param advertisableFQDN - The fully qualified domain name where this service is available. Does not include "https://".
   * @param adminToken - Optional. An administrative Bearer token used to protect admin routes.
   *                     If not provided, a random token will be generated at runtime.
   */
  constructor (
    public name: string,
    public privateKey: string,
    public advertisableFQDN: string,
    adminToken?: string
  ) {
    this.app = express()
    this.logger.log(chalk.green.bold(`${name} constructed`))
    this.adminToken = adminToken ?? uuidv4() // generate random if not provided
  }

  /**
   * Returns the current admin token in case you need to programmatically retrieve or display it.
   */
  getAdminToken (): string {
    return this.adminToken
  }

  /**
   * Configures the port on which the server will listen.
   * @param port - The port number
   */
  configurePort (port: number): void {
    this.port = port
    this.logger.log(chalk.blue(`Server port set to ${port}`))
  }

  /**
   * Configures the web user interface
   * @param config - Web UI configuration options
   */
  configureWebUI (config: UIConfig): void {
    this.webUIConfig = config
    this.logger.log(chalk.blue('Web UI has been configured.'))
  }

  /**
   * Configures the janitor service parameters
   * @param config - Janitor configuration options
   *   - requestTimeoutMs: Timeout for health check requests (default: 10000ms)
   *   - hostDownRevokeScore: Number of consecutive failures before deleting output (default: 3)
   *   - autoBanOnRemoval: Whether to auto-ban domains when removed by janitor (default: true)
   */
  configureJanitor (config: Partial<typeof this.janitorConfig>): void {
    this.janitorConfig = {
      ...this.janitorConfig,
      ...config
    }
    this.logger.log(chalk.blue('Janitor service has been configured.'))
  }

  /**
   * Configures health-report behavior.
   */
  configureHealth (config: Partial<HealthConfig>): void {
    this.healthConfig = {
      ...this.healthConfig,
      ...config
    }
    this.logger.log(chalk.blue('Health reporting has been configured.'))
  }

  /**
   * Registers an application-specific health check.
   */
  registerHealthCheck (definition: HealthCheckDefinition): void {
    this.healthChecks = this.healthChecks.filter(check => check.name !== definition.name)
    this.healthChecks.push({
      scope: 'ready',
      critical: false,
      ...definition
    })
    this.logger.log(chalk.blue(`Registered health check ${definition.name}`))
  }

  /**
   * Configures the admin identity key for wallet-based admin detection.
   * When set, the frontend can compare the user's wallet identity key against this
   * to determine whether to show the admin dashboard.
   *
   * @param identityKey - The hex-encoded public key of the admin
   */
  configureAdminIdentityKey (identityKey: string): void {
    this.adminIdentityKey = identityKey
    this.logger.log(chalk.blue('Admin identity key has been configured.'))
  }

  /**
   * Configures the logger to be used by the server.
   * @param logger - A logger object (e.g., console)
   */
  configureLogger (logger: typeof console): void {
    this.logger = logger
    this.logger.log(chalk.blue('Logger has been configured.'))
  }

  /**
   * Configures the BSV Blockchain network to be used ('main' or 'test').
   * By default, it re-initializes chainTracker as a WhatsOnChain for that network.
   * @param network - The network ('main' or 'test')
   */
  configureNetwork (network: 'main' | 'test'): void {
    this.network = network
    this.chainTracker = new WhatsOnChain(this.network)
    this.logger.log(chalk.blue(`Network set to ${network}`))
  }

  /**
   * Configures the ChainTracker to be used.
   * If 'scripts only' is used, it implies no full SPV chain tracking in the Engine.
   * @param chainTracker - An instance of ChainTracker or 'scripts only'
   */
  configureChainTracker (chainTracker: ChainTracker | 'scripts only' = new WhatsOnChain(this.network)): void {
    this.chainTracker = chainTracker
    this.logger.log(chalk.blue('ChainTracker has been configured.'))
  }

  /**
   * Configures the ARC API key.
   * @param apiKey - The ARC API key
   */
  configureArcApiKey (apiKey: string): void {
    this.arcApiKey = apiKey
    this.logger.log(chalk.blue('ARC API key has been configured.'))
  }

  /**
   * Enables or disables GASP synchronization (high-level setting).
   * This is a broad toggle that can be overridden or customized through syncConfiguration.
   * @param enable - true to enable, false to disable
   */
  configureEnableGASPSync (enable: boolean): void {
    this.enableGASPSync = enable
    this.logger.log(chalk.blue(`GASP synchronization ${enable ? 'enabled' : 'disabled'}.`))
  }

  /**
   * Enables or disables verbose request logging.
   * @param enable - true to enable, false to disable
   */
  configureVerboseRequestLogging (enable: boolean): void {
    this.verboseRequestLogging = enable
    this.logger.log(chalk.blue(`Verbose request logging ${enable ? 'enabled' : 'disabled'}.`))
  }

  /**
   * Configure Knex (SQL) database connection.
   * @param config - Knex configuration object, or MySQL connection string (e.g. mysql://overlayAdmin:overlay123@mysql:3306/overlay).
   */
  async configureKnex (config: Knex.Knex.Config | string): Promise<void> {
    if (typeof config === 'string') {
      config = {
        client: 'mysql2',
        connection: config
      }
    }
    this.knex = Knex(config)
    this.logger.log(chalk.blue('Knex successfully configured.'))
  }

  /**
   * Configures the MongoDB database connection.
   * Also initializes the BanService for persistent ban tracking.
   * @param connectionString - MongoDB connection string
   */
  async configureMongo (connectionString: string): Promise<void> {
    const mongoClient = new MongoClient(connectionString)
    await mongoClient.connect()
    this.mongoClient = mongoClient
    const db = mongoClient.db(`${this.name}_lookup_services`)
    this.mongoDb = db

    // Initialize the BanService
    this.banService = new BanService(db)
    await this.banService.ensureIndexes()

    this.logger.log(chalk.blue('MongoDB successfully configured and connected.'))
  }

  /**
   * Configures a Topic Manager.
   * @param name - The name of the Topic Manager
   * @param manager - An instance of TopicManager
   */
  configureTopicManager (name: string, manager: TopicManager): void {
    this.managers[name] = manager
    this.logger.log(chalk.blue(`Configured topic manager ${name}`))
  }

  /**
   * Configures a Lookup Service.
   * @param name - The name of the Lookup Service
   * @param service - An instance of LookupService
   */
  configureLookupService (name: string, service: LookupService): void {
    this.services[name] = service
    this.logger.log(chalk.blue(`Configured lookup service ${name}`))
  }

  /**
   * Configures a Lookup Service using Knex (SQL) database.
   * @param name - The name of the Lookup Service
   * @param serviceFactory - A factory function that creates a LookupService instance using Knex
   */
  configureLookupServiceWithKnex (
    name: string,
    serviceFactory: (knex: Knex.Knex) => { service: LookupService, migrations: Migration[] }
  ): void {
    const knex = this.ensureKnex()
    const factoryResult = serviceFactory(knex)
    this.services[name] = factoryResult.service
    this.migrationsToRun.push(...factoryResult.migrations)
    this.logger.log(chalk.blue(`Configured lookup service ${name} with Knex`))
  }

  /**
   * Configures a Lookup Service using MongoDB.
   * @param name - The name of the Lookup Service
   * @param serviceFactory - A factory function that creates a LookupService instance using MongoDB
   */
  configureLookupServiceWithMongo (name: string, serviceFactory: (mongoDb: Db) => LookupService): void {
    const mongoDb = this.ensureMongo()
    this.services[name] = serviceFactory(mongoDb)
    this.logger.log(chalk.blue(`Configured lookup service ${name} with MongoDB`))
  }

  /**
   * Advanced configuration method for setting or overriding any
   * Engine constructor parameters via an EngineConfig object.
   *
   * Example usage:
   *   configureEngineParams({
   *     logTime: true,
   *     throwOnBroadcastFailure: true,
   *     overlayBroadcastFacilitator: new MyCustomFacilitator()
   *   })
   *
   * These fields will be respected when we finally build/configure the Engine
   * in the `configureEngine()` method below.
   */
  configureEngineParams (params: EngineConfig): void {
    this.engineConfig = {
      ...this.engineConfig,
      ...params
    }
    this.logger.log(chalk.blue('Advanced Engine configuration params have been updated.'))
  }

  /**
   * Configures the Overlay Engine itself.
   * By default, auto-configures SHIP and SLAP unless autoConfigureShipSlap = false
   * Then it merges in any advanced engine config from `this.engineConfig`.
   *
   * When a BanService is available (from configureMongo), SHIP and SLAP lookup
   * services are automatically wrapped with BanAwareLookupWrapper to prevent
   * GASP from re-syncing banned tokens.
   *
   * @param autoConfigureShipSlap - Whether to auto-configure SHIP and SLAP services (default: true)
   */
  async configureEngine (autoConfigureShipSlap = true): Promise<void> {
    const knex = this.ensureKnex()

    if (autoConfigureShipSlap) {
      // Auto-configure SHIP and SLAP services
      this.configureTopicManager('tm_ship', new DiscoveryServices.SHIPTopicManager())
      this.configureTopicManager('tm_slap', new DiscoveryServices.SLAPTopicManager())
      this.configureLookupServiceWithMongo('ls_ship', (db) => new DiscoveryServices.SHIPLookupService(
        new DiscoveryServices.SHIPStorage(db)
      ))
      this.configureLookupServiceWithMongo('ls_slap', (db) => new DiscoveryServices.SLAPLookupService(
        new DiscoveryServices.SLAPStorage(db)
      ))
    }

    // Wrap SHIP/SLAP lookup services with ban-aware wrappers if BanService is available.
    // This prevents GASP from re-syncing tokens whose domains or outpoints have been banned.
    if (this.banService !== undefined) {
      if (this.services.ls_ship !== undefined) {
        this.services.ls_ship = new BanAwareLookupWrapper(
          this.services.ls_ship,
          this.banService,
          'SHIP',
          this.logger
        )
        this.logger.log(chalk.blue('SHIP lookup service wrapped with ban-aware filter.'))
      }
      if (this.services.ls_slap !== undefined) {
        this.services.ls_slap = new BanAwareLookupWrapper(
          this.services.ls_slap,
          this.banService,
          'SLAP',
          this.logger
        )
        this.logger.log(chalk.blue('SLAP lookup service wrapped with ban-aware filter.'))
      }
    }

    // Construct a default sync configuration, in case the user doesn't want GASP at all:
    let syncConfig: Record<string, string[] | 'SHIP' | false> = {}
    if (!this.enableGASPSync) {
      // For each manager, disable sync
      for (const managerName of Object.keys(this.managers)) {
        syncConfig[managerName] = false
      }
    } else {
      // If the user provided a syncConfiguration, use that. Otherwise default to an empty object.
      syncConfig = this.engineConfig.syncConfiguration ?? {}
    }

    // Build the actual Storage
    const storage = new KnexStorage(knex)
    // Include the KnexStorage migrations
    this.migrationsToRun = [...KnexStorageMigrations.default, ...this.migrationsToRun]

    // Prepare broadcaster if arcApiKey is set
    let broadcaster: Broadcaster | undefined
    if (typeof this.arcApiKey === 'string') {
      broadcaster = new ARC(
        // We hard-code some ARC URLs for now, but we should make this configurable later.
        this.network === 'test' ? 'https://arc-test.taal.com' : 'https://arc.taal.com',
        {
          apiKey: this.arcApiKey
        })
    }

    // Prepare advertiser if not set by the user
    let advertiser: Advertiser | undefined = this.engineConfig.advertiser
    if (typeof advertiser === 'undefined') {
      try {
        advertiser = new DiscoveryServices.WalletAdvertiser(
          this.network,
          this.privateKey,
          // Default to Babbage-hosted storage for SHIP/SLAP advertisement
          // metadata. This is a vendor-hosted default, not a protocol
          // requirement, and should become configurable.
          this.network === 'test'
            ? 'https://staging-storage.babbage.systems'
            : 'https://storage.babbage.systems',
          // Until multiple protocols (like https+bsvauth+smf) are fully supported, HTTPS is the one to always use.
          `https://${this.advertisableFQDN}`
        )
      } catch (e) {
        this.logger.log(`Advertiser not initialized for FQDN ${this.advertisableFQDN} - SHIP and SLAP will be disabled.`)
      }
    }

    // Construct the Engine with any advanced config overrides. Fallback to defaults.
    this.engine = new Engine(
      this.managers,
      this.services,
      storage,
      // chainTracker
      typeof this.engineConfig.chainTracker !== 'undefined'
        ? this.engineConfig.chainTracker
        : this.chainTracker,
      // hostingURL
      `https://${this.advertisableFQDN}`,
      // shipTrackers
      this.network === 'test'
        ? (this.engineConfig.shipTrackers ?? DEFAULT_TESTNET_SLAP_TRACKERS)
        : this.engineConfig.shipTrackers,
      // slapTrackers
      Array.isArray(this.engineConfig.slapTrackers)
        ? this.engineConfig.slapTrackers
        : this.network === 'test'
          ? DEFAULT_TESTNET_SLAP_TRACKERS
          : DEFAULT_SLAP_TRACKERS,
      // broadcaster
      broadcaster ?? this.engineConfig.broadcaster,
      // advertiser
      advertiser,
      // syncConfiguration
      syncConfig,
      // logTime
      this.engineConfig.logTime ?? false,
      // logPrefix
      this.engineConfig.logPrefix ?? '[OVERLAY_ENGINE] ',
      // throwOnBroadcastFailure
      this.engineConfig.throwOnBroadcastFailure ?? false,
      // overlayBroadcastFacilitator
      this.engineConfig.overlayBroadcastFacilitator ?? new HTTPSOverlayBroadcastFacilitator(),
      // logger
      this.logger,
      // suppressDefaultSyncAdvertisements
      this.engineConfig.suppressDefaultSyncAdvertisements ?? true
    )

    // Create the server wallet for BSV mutual authentication.
    // This uses the same private key as the WalletAdvertiser.
    try {
      const keyDeriver = new KeyDeriver(new PrivateKey(this.privateKey, 'hex'))
      const storageManager = new WalletStorageManager(keyDeriver.identityKey)
      const signer = new WalletSigner(this.network, keyDeriver, storageManager)
      const services = new Services(this.network)
      const wallet = new Wallet(signer, services)
      this.serverWallet = wallet

      // Auto-set the admin identity key from the server's own key if not configured
      if (typeof this.adminIdentityKey === 'undefined') {
        this.adminIdentityKey = keyDeriver.identityKey
      }

      this.logger.log(chalk.blue('Server wallet initialized for BSV mutual authentication.'))
    } catch (e) {
      this.logger.log(chalk.yellow('Server wallet could not be initialized. BSV auth will not be available.'))
    }

    this.logger.log(chalk.green('Engine has been configured.'))
  }

  /**
   * Ensures that Knex is configured and returns it.
   * @throws Error if Knex is not configured
   */
  private ensureKnex (): Knex.Knex {
    if (typeof this.knex === 'undefined') {
      throw new Error('You must configure your SQL database with the .configureKnex() method first!')
    }
    return this.knex
  }

  /**
   * Ensures that MongoDB is configured and returns it.
   * @throws Error if MongoDB is not configured
   */
  private ensureMongo (): Db {
    if (typeof this.mongoDb === 'undefined') {
      throw new Error('You must configure your MongoDB connection with the .configureMongo() method first!')
    }
    return this.mongoDb
  }

  /**
   * Ensures that the Overlay Engine is configured and returns it.
   * @throws Error if the Engine is not configured
   */
  private ensureEngine (): Engine {
    if (typeof this.engine === 'undefined') {
      throw new Error('You must configure your Overlay Services engine with the .configureEngine() method first!')
    }
    return this.engine
  }

  /**
   * Creates a JanitorService instance with current configuration.
   */
  private createJanitor (): JanitorService {
    const mongoDb = this.ensureMongo()
    return new JanitorService({
      mongoDb,
      logger: this.logger,
      requestTimeoutMs: this.janitorConfig.requestTimeoutMs,
      hostDownRevokeScore: this.janitorConfig.hostDownRevokeScore,
      banService: this.banService,
      autoBanOnRemoval: this.janitorConfig.autoBanOnRemoval
    })
  }

  private async runHealthCheck (
    definition: Required<Pick<HealthCheckDefinition, 'name' | 'scope' | 'critical'>> & { handler: HealthCheckHandler }
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now()

    try {
      const result = ((await Promise.race([
        Promise.resolve(definition.handler()),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Timed out after ${this.healthConfig.timeoutMs}ms`)), this.healthConfig.timeoutMs)
        })
      ])) ?? {}) as {
        status?: HealthStatus
        message?: string
        details?: Record<string, any>
      }

      return {
        name: definition.name,
        scope: definition.scope,
        critical: definition.critical,
        status: result.status ?? 'ok',
        message: result.message,
        details: result.details,
        durationMs: Date.now() - startedAt
      }
    } catch (error) {
      return {
        name: definition.name,
        scope: definition.scope,
        critical: definition.critical,
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown health-check error',
        durationMs: Date.now() - startedAt
      }
    }
  }

  private async collectHealthReport (mode: 'live' | 'ready' | 'full'): Promise<HealthReport> {
    const definitions: Array<Required<Pick<HealthCheckDefinition, 'name' | 'scope' | 'critical'>> & { handler: HealthCheckHandler }> = [
      {
        name: 'process',
        scope: 'live',
        critical: true,
        handler: async () => ({
          status: 'ok',
          details: {
            listening: this.isListening
          }
        })
      },
      {
        name: 'engine',
        scope: 'ready',
        critical: true,
        handler: async () => {
          if (typeof this.engine === 'undefined') {
            throw new Error('Overlay engine is not configured')
          }

          return {
            status: 'ok',
            details: {
              topicManagers: Object.keys(this.managers),
              lookupServices: Object.keys(this.services)
            }
          }
        }
      },
      {
        name: 'knex',
        scope: 'ready',
        critical: true,
        handler: async () => {
          if (typeof this.knex === 'undefined') {
            throw new Error('Knex is not configured')
          }

          await this.knex.raw('select 1 as ok')
          return {
            status: 'ok',
            details: {
              client: this.knex.client?.config?.client ?? 'unknown'
            }
          }
        }
      },
      {
        name: 'mongo',
        scope: 'ready',
        critical: true,
        handler: async () => {
          if (typeof this.mongoDb === 'undefined') {
            throw new Error('MongoDB is not configured')
          }

          await this.mongoDb.command({ ping: 1 })
          return {
            status: 'ok',
            details: {
              database: this.mongoDb.databaseName
            }
          }
        }
      }
    ]

    for (const check of this.healthChecks) {
      definitions.push({
        name: check.name,
        scope: check.scope ?? 'ready',
        critical: check.critical ?? false,
        handler: check.handler
      })
    }

    const filteredDefinitions = definitions.filter((definition) => {
      if (mode === 'full') {
        return true
      }

      return definition.scope === mode
    })

    const checks = await Promise.all(filteredDefinitions.map(async definition => await this.runHealthCheck(definition)))
    const liveChecks = checks.filter(check => check.scope === 'live')
    const readyChecks = checks.filter(check => check.scope === 'ready')
    const live = liveChecks.every(check => !check.critical || check.status === 'ok')
    const ready = readyChecks.every(check => !check.critical || check.status === 'ok')

    let status: HealthStatus = 'ok'
    if (!live || !ready || checks.some(check => check.critical && check.status === 'error')) {
      status = 'error'
    } else if (checks.some(check => check.status !== 'ok')) {
      status = 'degraded'
    }

    const context = typeof this.healthConfig.contextProvider === 'function'
      ? await this.healthConfig.contextProvider()
      : undefined

    const report: HealthReport = {
      status,
      live,
      ready,
      service: {
        name: this.name,
        advertisableFQDN: this.advertisableFQDN,
        port: this.port,
        network: this.network,
        startedAt: this.startTime?.toISOString(),
        uptimeMs: typeof this.startTime === 'undefined' ? 0 : Date.now() - this.startTime.getTime(),
        topicManagerCount: Object.keys(this.managers).length,
        lookupServiceCount: Object.keys(this.services).length
      },
      checks: this.healthConfig.includeDetails
        ? checks
        : checks.map(({ details, ...check }) => check),
      context
    }

    return report
  }

  /**
   * Starts the Express server.
   * Sets up routes and begins listening on the configured port.
   */
  async start (): Promise<void> {
    const engine = this.ensureEngine()
    const knex = this.ensureKnex()
    this.startTime = new Date()

    this.app.use(bodyParser.json({ limit: '1gb', type: 'application/json' }))
    this.app.use(bodyParser.raw({ limit: '1gb', type: 'application/octet-stream' }))

    if (this.verboseRequestLogging) {
      this.app.use((req, res, next) => {
        const startTime = Date.now()

        // Log incoming request details
        this.logger.log(chalk.magenta.bold(`Incoming Request: ${String(req.method)} ${String(req.originalUrl)}`))
        // Pretty-print headers
        this.logger.log(chalk.cyan('Headers:'))
        this.logger.log(util.inspect(req.headers, { colors: true, depth: null }))

        // Handle request body
        if (req.body != null && Object.keys(req.body).length > 0) {
          let bodyContent
          let bodyString
          if (typeof req.body === 'object') {
            bodyString = JSON.stringify(req.body, null, 2)
          } else if (Buffer.isBuffer(req.body)) {
            bodyString = req.body.toString('utf8')
          } else {
            bodyString = String(req.body)
          }
          if (bodyString.length > 280) {
            bodyContent = chalk.yellow(`(Body too long to display, length: ${String(bodyString.length)} characters)`)
          } else {
            bodyContent = chalk.green(`Request Body:\n${String(bodyString)}`)
          }
          this.logger.log(bodyContent)
        }

        // Intercept the res.send method to log responses
        const originalSend = res.send
        let responseBody: any

        res.send = function (body?: any): any {
          responseBody = body
          return originalSend.call(this, body)
        }

        // Log outgoing response details after the response is finished
        res.on('finish', () => {
          const duration = Date.now() - startTime
          this.logger.log(
            chalk.magenta.bold(
              `Outgoing Response: ${String(req.method)} ${String(req.originalUrl)} - Status: ${String(res.statusCode)} - Duration: ${String(duration)}ms`
            )
          )
          this.logger.log(chalk.cyan('Response Headers:'))
          this.logger.log(util.inspect(res.getHeaders(), { colors: true, depth: null }))

          // Handle response body
          if (responseBody != null) {
            let bodyContent
            let bodyString
            if (typeof responseBody === 'object') {
              bodyString = JSON.stringify(responseBody, null, 2)
            } else if (Buffer.isBuffer(responseBody)) {
              bodyString = responseBody.toString('utf8')
            } else if (typeof responseBody === 'string') {
              bodyString = responseBody
            } else {
              bodyString = String(responseBody)
            }
            if (bodyString.length > 280) {
              bodyContent = chalk.yellow(`(Response body too long to display, length: ${String(bodyString.length)} characters)`)
            } else {
              bodyContent = chalk.green(`Response Body:\n${String(bodyString)}`)
            }
            this.logger.log(bodyContent)
          }
        })

        next()
      })
    }

    // Enable CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*')
      res.header('Access-Control-Allow-Headers', '*')
      res.header('Access-Control-Allow-Methods', '*')
      res.header('Access-Control-Expose-Headers', '*')
      res.header('Access-Control-Allow-Private-Network', 'true')
      if (req.method === 'OPTIONS') {
        res.sendStatus(200)
      } else {
        next()
      }
    })

    // Serve a static documentation site or user interface
    this.app.get('/', (req, res) => {
      res.set('content-type', 'text/html')
      res.send(makeUserInterface({
        ...this.webUIConfig,
        adminIdentityKey: this.adminIdentityKey
      }))
    })

    // Serve health check endpoints
    this.app.get('/health/live', (_, res) => {
      ; (async () => {
        const report = await this.collectHealthReport('live')
        return res.status(report.live ? 200 : 503).json(report)
      })().catch((error) => {
        res.status(500).json({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unexpected error'
        })
      })
    })

    this.app.get('/health/ready', (_, res) => {
      ; (async () => {
        const report = await this.collectHealthReport('ready')
        return res.status(report.ready ? 200 : 503).json(report)
      })().catch((error) => {
        res.status(500).json({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unexpected error'
        })
      })
    })

    this.app.get('/health', (_, res) => {
      ; (async () => {
        const report = await this.collectHealthReport('full')
        return res.status(report.ready ? 200 : 503).json(report)
      })().catch((error) => {
        res.status(500).json({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unexpected error'
        })
      })
    })

    // List hosted topic managers and lookup services
    this.app.get('/listTopicManagers', (_, res) => {
      ; (async () => {
        try {
          const result = await engine.listTopicManagers()
          return res.status(200).json(result)
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    this.app.get('/listLookupServiceProviders', (_, res) => {
      ; (async () => {
        try {
          const result = await engine.listLookupServiceProviders()
          return res.status(200).json(result)
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    // Host documentation for the services
    this.app.get('/getDocumentationForTopicManager', (req, res) => {
      ; (async () => {
        try {
          const manager = req.query.manager as string
          const result = await engine.getDocumentationForTopicManager(manager)
          res.setHeader('Content-Type', 'text/markdown')
          return res.status(200).send(result)
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    this.app.get('/getDocumentationForLookupServiceProvider', (req, res) => {
      ; (async () => {
        try {
          const lookupService = req.query.lookupService as string
          const result = await engine.getDocumentationForLookupServiceProvider(lookupService)
          res.setHeader('Content-Type', 'text/markdown')
          return res.status(200).send(result)
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    // Submit transactions and facilitate lookup requests
    this.app.post('/submit', (req, res) => {
      ; (async () => {
        try {
          // Parse out the topics and construct the tagged BEEF
          const topicsHeader = req.headers['x-topics']
          const includesOffChain = req.headers['x-includes-off-chain-values'] === 'true'
          if (typeof topicsHeader !== 'string') {
            throw new Error('Missing x-topics header')
          }
          const topics = JSON.parse(topicsHeader)
          let offChainValues: number[] | undefined
          let beef = Array.from(req.body as number[])
          if (includesOffChain) {
            const r = new Utils.Reader(beef)
            const l = r.readVarIntNum()
            beef = r.read(l)
            offChainValues = r.read()
          }
          const taggedBEEF: TaggedBEEF = {
            beef,
            topics,
            offChainValues
          }

          // Using a callback function, we can return once the STEAK is ready
          let responseSent = false
          const steak = await engine.submit(taggedBEEF, (steak: STEAK) => {
            responseSent = true
            return res.status(200).json(steak)
          }, 'current-tx', offChainValues)
          if (!responseSent) {
            res.status(200).json(steak)
          }
        } catch (error) {
          console.error(chalk.red('Error in /submit:'), error)
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    this.app.post('/lookup', (req, res) => {
      ; (async () => {
        try {
          // Check for aggregation header to determine response format
          const aggregationHeader = req.headers['x-aggregation']
          const shouldReturnBinary = aggregationHeader === 'yes'

          // Validate request body structure
          const lookupRequest = req.body as { service: string, query: unknown }
          if (typeof lookupRequest.service !== 'string' || lookupRequest.query === undefined) {
            return res.status(400).json({
              status: 'error',
              message: 'Invalid request: body must contain "service" (string) and "query" fields'
            })
          }

          const result = await engine.lookup(lookupRequest)

          if (!shouldReturnBinary) {
            // Return JSON response (default behavior)
            return res.status(200).json(result)
          }

          const beef = new Beef()
          const outputs = result.outputs

          // Serialize in the format expected by LookupResolver
          const writer = new Utils.Writer()

          // Write number of outpoints
          writer.writeVarIntNum(outputs.length)

          // Write each outpoint data
          for (const output of outputs) {
            const tx = Transaction.fromBEEF(output.beef)
            // Write txid (32 bytes)
            writer.write(tx.id())
            // Write outputIndex
            writer.writeVarIntNum(output.outputIndex)
            // Write context length and data
            if ((output.context != null) && output.context.length > 0) {
              writer.writeVarIntNum(output.context.length)
              writer.write(output.context)
            } else {
              writer.writeVarIntNum(0)
            }
            beef.mergeTransaction(tx)
          }

          // Write the beef data
          writer.write(beef.toBinary())

          res.setHeader('Content-Type', 'application/octet-stream')
          return res.status(200).send(Buffer.from(writer.toArray()))
        } catch (error) {
          console.error(chalk.red('Error in /lookup:'), error)
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    // ARC ingest route (only if we have an ARC API key)
    if (typeof this.arcApiKey === 'string' && this.arcApiKey.length > 0) {
      this.app.post('/arc-ingest', (req, res) => {
        ; (async () => {
          try {
            const { txid, merklePath: merklePathHex, blockHeight } = req.body
            const merklePath = MerklePath.fromHex(merklePathHex)
            await engine.handleNewMerkleProof(txid, merklePath, blockHeight)
            return res.status(200).json({ status: 'success', message: 'Transaction status updated' })
          } catch (error) {
            console.error(chalk.red('Error in /arc-ingest:'), error)
            return res.status(400).json({
              status: 'error',
              message: error instanceof Error ? error.message : 'An unknown error occurred'
            })
          }
        })().catch(() => {
          res.status(500).json({
            status: 'error',
            message: 'Unexpected error'
          })
        })
      })
    } else {
      this.logger.warn(chalk.yellow('Disabling ARC because no ARC API key was provided.'))
    }

    // GASP sync routes if enabled
    if (this.enableGASPSync) {
      this.app.post('/requestSyncResponse', (req, res) => {
        ; (async () => {
          try {
            const topic = req.headers['x-bsv-topic'] as string
            const response = await engine.provideForeignSyncResponse(req.body, topic)
            return res.status(200).json(response)
          } catch (error) {
            console.error(chalk.red('Error in /requestSyncResponse:'), error)
            return res.status(400).json({
              status: 'error',
              message: error instanceof Error ? error.message : 'An unknown error occurred'
            })
          }
        })().catch(() => {
          res.status(500).json({
            status: 'error',
            message: 'Unexpected error'
          })
        })
      })

      this.app.post('/requestForeignGASPNode', (req, res) => {
        ; (async () => {
          try {
            const { graphID, txid, outputIndex } = req.body
            const response = await engine.provideForeignGASPNode(graphID, txid, outputIndex)
            return res.status(200).json(response)
          } catch (error) {
            console.error(chalk.red('Error in /requestForeignGASPNode:'), error)
            return res.status(400).json({
              status: 'error',
              message: error instanceof Error ? error.message : 'An unknown error occurred'
            })
          }
        })().catch(() => {
          res.status(500).json({
            status: 'error',
            message: 'Unexpected error'
          })
        })
      })
    } else {
      this.logger.warn(chalk.yellow('GASP sync is disabled.'))
    }

    /**
     * ============== ADMIN ROUTES ==============
     * These routes expose advanced engine operations.
     * Authentication: Bearer token OR BSV mutual auth (identity key match).
     */

    /**
     * Set up BSV mutual authentication middleware if a server wallet is available.
     * This handles the /.well-known/auth handshake automatically.
     * With allowUnauthenticated: true, it passes through when no BSV auth headers
     * are present, allowing Bearer token fallback.
     */
    if (this.serverWallet !== undefined) {
      const bsvAuth = createAuthMiddleware({
        wallet: this.serverWallet,
        allowUnauthenticated: true
      })
      this.app.use(bsvAuth as any)
      this.logger.log(chalk.blue('BSV mutual authentication middleware enabled.'))
    }

    /**
     * Middleware for checking admin authentication.
     * Supports two authentication methods:
     * 1. Bearer token (Authorization: Bearer <token>) - for cron jobs, scripts, and fallback
     * 2. BSV mutual auth - if req.auth.identityKey matches the admin identity key
     */
    const checkAdminAuth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      // Method 1: BSV mutual authentication (identity key match)
      const authReq = req as AuthRequest
      if (
        typeof this.adminIdentityKey === 'string' &&
        authReq.auth !== undefined &&
        typeof authReq.auth.identityKey === 'string' &&
        authReq.auth.identityKey !== 'unknown' &&
        authReq.auth.identityKey === this.adminIdentityKey
      ) {
        next()
        return
      }

      // Method 2: Bearer token authentication
      const authHeader = req.headers.authorization
      if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring('Bearer '.length)
        if (token === this.adminToken) {
          next()
          return
        }
        res.status(403).json({ status: 'error', message: 'Forbidden: Invalid credentials' })
        return
      }

      res.status(401).json({ status: 'error', message: 'Unauthorized: Provide a Bearer token or authenticate with your wallet' })
    }

    /**
     * Public endpoint that returns the admin identity key (if configured).
     * This allows the frontend to detect whether the current wallet user
     * is the admin by comparing their identity key against this value.
     * The identity key is a public key, so exposing it is safe.
     */
    this.app.get('/admin/config', (_, res) => {
      res.status(200).json({
        adminIdentityKey: this.adminIdentityKey ?? null,
        nodeName: this.name
      })
    })

    /**
     * Admin route: Get server statistics and overview.
     */
    this.app.get('/admin/stats', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          const db = this.ensureMongo()

          const [shipCount, slapCount, banStats] = await Promise.all([
            db.collection('shipRecords').countDocuments(),
            db.collection('slapRecords').countDocuments(),
            this.banService?.getStats() ?? { domainBans: 0, outpointBans: 0, totalBans: 0 }
          ])

          return res.status(200).json({
            status: 'success',
            data: {
              nodeName: this.name,
              network: this.network,
              uptime: this.startTime !== undefined ? Date.now() - this.startTime.getTime() : 0,
              startedAt: this.startTime?.toISOString(),
              shipRecordCount: shipCount,
              slapRecordCount: slapCount,
              bannedDomains: banStats.domainBans,
              bannedOutpoints: banStats.outpointBans,
              totalBans: banStats.totalBans,
              topicManagers: Object.keys(this.managers),
              lookupServices: Object.keys(this.services),
              gaspSyncEnabled: this.enableGASPSync
            }
          })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({ status: 'error', message: 'Unexpected error' })
      })
    })

    /**
     * Admin route: List all SHIP records with full details.
     */
    this.app.get('/admin/ship-records', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          const db = this.ensureMongo()
          const collection = db.collection('shipRecords')

          const search = typeof req.query.search === 'string' ? req.query.search : undefined
          const rawPage = parseInt(req.query.page as string, 10)
          const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage)
          const rawLimit = parseInt(req.query.limit as string, 10)
          const limit = Math.min(200, Math.max(1, Number.isNaN(rawLimit) ? 50 : rawLimit))
          const skip = (page - 1) * limit

          const query: any = {}
          if (typeof search === 'string' && search.length > 0) {
            query.$or = [
              { domain: { $regex: search, $options: 'i' } },
              { topic: { $regex: search, $options: 'i' } },
              { identityKey: { $regex: search, $options: 'i' } },
              { txid: { $regex: search, $options: 'i' } }
            ]
          }

          const [records, total] = await Promise.all([
            collection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
            collection.countDocuments(query)
          ])

          return res.status(200).json({
            status: 'success',
            data: { records, total, page, limit, pages: Math.ceil(total / limit) }
          })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({ status: 'error', message: 'Unexpected error' })
      })
    })

    /**
     * Admin route: List all SLAP records with full details.
     */
    this.app.get('/admin/slap-records', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          const db = this.ensureMongo()
          const collection = db.collection('slapRecords')

          const search = typeof req.query.search === 'string' ? req.query.search : undefined
          const rawPage = parseInt(req.query.page as string, 10)
          const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage)
          const rawLimit = parseInt(req.query.limit as string, 10)
          const limit = Math.min(200, Math.max(1, Number.isNaN(rawLimit) ? 50 : rawLimit))
          const skip = (page - 1) * limit

          const query: any = {}
          if (typeof search === 'string' && search.length > 0) {
            query.$or = [
              { domain: { $regex: search, $options: 'i' } },
              { service: { $regex: search, $options: 'i' } },
              { identityKey: { $regex: search, $options: 'i' } },
              { txid: { $regex: search, $options: 'i' } }
            ]
          }

          const [records, total] = await Promise.all([
            collection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
            collection.countDocuments(query)
          ])

          return res.status(200).json({
            status: 'success',
            data: { records, total, page, limit, pages: Math.ceil(total / limit) }
          })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({ status: 'error', message: 'Unexpected error' })
      })
    })

    /**
     * Admin route: Check health of a specific URL.
     */
    this.app.post('/admin/health-check', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          const { url } = req.body
          if (typeof url !== 'string' || url.length === 0) {
            return res.status(400).json({ status: 'error', message: 'url is required' })
          }
          const janitor = this.createJanitor()
          const result = await janitor.checkHost(url)
          return res.status(200).json({ status: 'success', data: { url, ...result } })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({ status: 'error', message: 'Unexpected error' })
      })
    })

    /**
     * Admin route: Ban a domain or outpoint.
     */
    this.app.post('/admin/ban', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          if (this.banService === undefined) {
            return res.status(400).json({ status: 'error', message: 'Ban service not available (MongoDB not configured)' })
          }

          const { type, value, reason } = req.body
          if (type !== 'domain' && type !== 'outpoint') {
            return res.status(400).json({ status: 'error', message: 'type must be "domain" or "outpoint"' })
          }
          if (typeof value !== 'string' || value.length === 0) {
            return res.status(400).json({ status: 'error', message: 'value is required' })
          }

          if (type === 'domain') {
            await this.banService.banDomain(value, reason)

            // Also remove any existing records for this domain from SHIP and SLAP
            const db = this.ensureMongo()
            const [shipDeleted, slapDeleted] = await Promise.all([
              db.collection('shipRecords').deleteMany({ domain: value }),
              db.collection('slapRecords').deleteMany({ domain: value })
            ])

            return res.status(200).json({
              status: 'success',
              message: `Domain "${value}" banned. Removed ${shipDeleted.deletedCount} SHIP and ${slapDeleted.deletedCount} SLAP records.`
            })
          } else {
            // Parse outpoint: "txid.outputIndex"
            const dotIndex = value.lastIndexOf('.')
            if (dotIndex === -1) {
              return res.status(400).json({ status: 'error', message: 'Outpoint format must be "txid.outputIndex"' })
            }
            const txid = value.substring(0, dotIndex)
            const outputIndex = parseInt(value.substring(dotIndex + 1))
            if (isNaN(outputIndex)) {
              return res.status(400).json({ status: 'error', message: 'Invalid outputIndex in outpoint' })
            }

            await this.banService.banOutpoint(txid, outputIndex, reason)

            // Also evict from lookup services
            const services = Object.values(engine.lookupServices)
            for (const service of services) {
              try {
                await service.outputEvicted(txid, outputIndex)
              } catch {
                continue
              }
            }

            return res.status(200).json({
              status: 'success',
              message: `Outpoint "${value}" banned and evicted from lookup services.`
            })
          }
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({ status: 'error', message: 'Unexpected error' })
      })
    })

    /**
     * Admin route: Remove a ban.
     */
    this.app.post('/admin/unban', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          if (this.banService === undefined) {
            return res.status(400).json({ status: 'error', message: 'Ban service not available' })
          }
          const { type, value } = req.body as { type: unknown, value: unknown }
          if (type !== 'domain' && type !== 'outpoint') {
            return res.status(400).json({ status: 'error', message: 'type must be "domain" or "outpoint"' })
          }
          if (typeof value !== 'string' || value.length === 0) {
            return res.status(400).json({ status: 'error', message: 'value is required' })
          }

          await this.banService.removeBan(type, value)
          return res.status(200).json({ status: 'success', message: `${type} "${String(value)}" unbanned.` })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({ status: 'error', message: 'Unexpected error' })
      })
    })

    /**
     * Admin route: List all bans.
     */
    this.app.get('/admin/bans', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          if (this.banService === undefined) {
            return res.status(200).json({ status: 'success', data: { bans: [] } })
          }
          const type = req.query.type as 'domain' | 'outpoint' | undefined
          const validType = type === 'domain' || type === 'outpoint' ? type : undefined
          const bans = await this.banService.listBans(validType)
          return res.status(200).json({ status: 'success', data: { bans } })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({ status: 'error', message: 'Unexpected error' })
      })
    })

    /**
     * Admin route: Remove a token by outpoint, optionally banning the domain.
     */
    this.app.post('/admin/remove-token', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          const { txid, outputIndex, service, ban, banDomain: shouldBanDomain } = req.body
          if (typeof txid !== 'string' || typeof outputIndex !== 'number') {
            return res.status(400).json({ status: 'error', message: 'txid (string) and outputIndex (number) are required' })
          }

          // Get the domain before removing (for ban option)
          let removedDomain: string | undefined
          if (shouldBanDomain === true || ban === true) {
            const db = this.ensureMongo()
            const shipRecord = await db.collection('shipRecords').findOne({ txid, outputIndex })
            const slapRecord = await db.collection('slapRecords').findOne({ txid, outputIndex })
            removedDomain = (shipRecord?.domain ?? slapRecord?.domain) as string | undefined
          }

          // Evict from specified service or all services
          if (typeof service === 'string') {
            const svc = engine.lookupServices[service]
            if (svc !== undefined) {
              await svc.outputEvicted(txid, outputIndex)
            }
          } else {
            const services = Object.values(engine.lookupServices)
            for (const svc of services) {
              try {
                await svc.outputEvicted(txid, outputIndex)
              } catch {
                continue
              }
            }
          }

          // Ban the outpoint if requested
          if (ban === true && this.banService !== undefined) {
            await this.banService.banOutpoint(txid, outputIndex, 'Manually removed by admin', removedDomain)
          }

          // Ban the domain if requested
          if (shouldBanDomain === true && typeof removedDomain === 'string' && this.banService !== undefined) {
            await this.banService.banDomain(removedDomain, 'Domain banned by admin via token removal')

            // Remove all records for this domain
            const banDb = this.ensureMongo()
            await Promise.all([
              banDb.collection('shipRecords').deleteMany({ domain: removedDomain }),
              banDb.collection('slapRecords').deleteMany({ domain: removedDomain })
            ])
          }

          return res.status(200).json({
            status: 'success',
            message: `Token ${txid}.${outputIndex} removed.${ban === true ? ' Outpoint banned.' : ''}${shouldBanDomain === true && typeof removedDomain === 'string' ? ` Domain "${removedDomain}" banned.` : ''}`
          })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({ status: 'error', message: 'Unexpected error' })
      })
    })

    /**
     * Admin route to manually sync advertisements, calling `engine.syncAdvertisements()`.
     */
    this.app.post('/admin/syncAdvertisements', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          await engine.syncAdvertisements()
          return res.status(200).json({ status: 'success', message: 'Advertisements synced successfully' })
        } catch (error) {
          console.error(chalk.red('Error in /admin/syncAdvertisements:'), error)
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    /**
     * Admin route to manually start GASP sync, calling `engine.startGASPSync()`.
     */
    this.app.post('/admin/startGASPSync', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          await engine.startGASPSync()
          return res.status(200).json({ status: 'success', message: 'GASP sync started and completed' })
        } catch (error) {
          console.error(chalk.red('Error in /admin/startGASPSync:'), error)
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    /**
     * Admin route to evict an outpoint, either from all services or a specific one.
     */
    this.app.post('/admin/evictOutpoint', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          if (typeof req.body.service === 'string') {
            const service = engine.lookupServices[req.body.service]
            await service.outputEvicted(req.body.txid, req.body.outputIndex)
          } else {
            const services = Object.values(engine.lookupServices)
            for (let i = 0; i < services.length; i++) {
              try {
                await services[i].outputEvicted(req.body.txid, req.body.outputIndex)
              } catch {
                continue
              }
            }
          }
          return res.status(200).json({ status: 'success', message: 'Outpoint evicted' })
        } catch (error) {
          console.error(chalk.red('Error in /admin/evictOutpoint:'), error)
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    /**
     * Admin route to run the janitor service with enhanced reporting.
     */
    this.app.post('/admin/janitor', checkAdminAuth as any, (req, res) => {
      ; (async () => {
        try {
          const janitor = this.createJanitor()
          const report: JanitorReport = await janitor.run()
          return res.status(200).json({ status: 'success', message: 'Janitor run completed', data: report })
        } catch (error) {
          console.error(chalk.red('Error in /admin/janitor:'), error)
          return res.status(400).json({
            status: 'error',
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    // Automatically handle migrations
    const migrationSource = new InMemoryMigrationSource(this.migrationsToRun)
    const result = await knex.migrate.latest({
      migrationSource
    })
    this.logger.log(chalk.green('Knex migrations run'), result)

    // 404 handler for all other routes
    this.app.use((req, res) => {
      this.logger.log(chalk.red('404 Not Found:'), req.url)
      res.status(404).json({
        status: 'error',
        code: 'ERR_ROUTE_NOT_FOUND',
        description: 'Route not found.'
      })
    })

    // The legacy Ninja advertiser has a setLookupEngine method.
    if (this.engine?.advertiser instanceof DiscoveryServices.WalletAdvertiser) {
      this.logger.log(
        chalk.cyan(
          `${this.name} will now advertise with SHIP and SLAP as appropriate at FQDN: ${this.advertisableFQDN}`
        )
      )
      await this.engine.advertiser.init()
    }

    // Log some info about topic managers and services
    const numTopicManagers = Object.keys(this.managers).length
    const numLookupServices = Object.keys(this.services).length
    this.logger.log(chalk.blue(`Topic Managers:  ${numTopicManagers}`))
    this.logger.log(chalk.blue(`Lookup Services: ${numLookupServices}`))

    // Attempt to sync advertisements
    try {
      await this.engine?.syncAdvertisements()
    } catch (e) {
      this.logger.log(chalk.red('Error syncing advertisements:'), e)
    }

    // Attempt to do GASP sync if enabled
    if (this.enableGASPSync) {
      try {
        this.logger.log(chalk.green('Starting GASP sync...'))
        await this.engine?.startGASPSync()
        this.logger.log(chalk.green('GASP sync complete!'))
      } catch (e) {
        console.error(chalk.red('Failed to GASP sync'), e)
      }
    } else {
      this.logger.log(chalk.yellow(`${this.name} will not sync because GASP has been disabled.`))
    }

    // Start listening on the configured port
    this.app.listen(this.port, () => {
      this.isListening = true
      this.logger.log(chalk.green.bold(`${this.name} is ready and listening on local port ${this.port}`))
    })
  }
}
