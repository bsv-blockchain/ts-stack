import express, { type Request, type Response } from 'express'
import bodyParser from 'body-parser'
import {
  Engine,
  KnexStorage,
  LookupService,
  TopicManager,
  KnexStorageMigrations,
  Advertiser,
  serializeErrorForLog,
  serializeLogValue
} from '@bsv/overlay'
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
  WalletInterface,
  SessionManager,
  AsyncSessionManager
} from '@bsv/sdk'
import Knex from 'knex'
import { MongoClient, Db } from 'mongodb'
import makeUserInterface, { type UIConfig } from './makeUserInterface.js'
import * as DiscoveryServices from '@bsv/overlay-discovery-services'
import chalk from 'chalk'
import { v4 as uuidv4 } from 'uuid'
import { createHash, timingSafeEqual } from 'node:crypto'
import { JanitorService, type JanitorReport } from './JanitorService.js'
import { BanService } from './BanService.js'
import { BanAwareLookupWrapper } from './BanAwareLookupWrapper.js'
import { BanAwareTopicManager } from './BanAwareTopicManager.js'
import { BanAwareSHIPStorage, BanAwareSLAPStorage } from './BanAwareDiscoveryStorage.js'
import { ReorgSseAdapter, type ReorgHandlerInput } from './ReorgStream.js'
import { Wallet, WalletSigner, WalletStorageManager, Services } from '@bsv/wallet-toolbox-client'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import { ArcadeProvider, isTerminalArcStatus, type ArcadeMerkleProof } from './ArcadeProvider.js'
import { ProviderChainBroadcaster, type NamedBroadcaster } from './ProviderChainBroadcaster.js'
import { ChaintracksProvider } from './ChaintracksProvider.js'
import type { Server } from 'node:http'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  configureHttpServer,
  corsPolicy,
  readBodyLimitBytes,
  securityHeaders,
  type HttpServerPolicyDefaults,
  type SecurityHeadersOptions
} from './security/edgePolicy.js'

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
  async getMigrations (_loadExtensions: readonly string[]): Promise<Migration[]> {
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
  topicAnchorHeaderResolver?: TopicAnchorHeaderResolver
  enableBASMSync?: boolean
  unprovenEvictionBlocks?: number
  reorgStreamUrl?: string
  reorgScanDepth?: number
  unprovenMaintenanceIntervalMs?: number
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

export interface EdgePolicyConfig {
  environmentPrefix: string
  allowedOrigins?: string[]
  jsonBodyLimitBytes: number
  binaryBodyLimitBytes: number
  maxConcurrentRequests: number
  http: HttpServerPolicyDefaults
  securityHeaders: SecurityHeadersOptions
}

export type TopicAnchorHeaderResolver = (blockHeight: number) => Promise<{
  blockHeight: number
  blockHash: string
  merkleRoot?: string
} | undefined>

interface BASMCapableEngine extends Engine {
  provideTopicAnchorTip: (topic: string) => Promise<any>
  provideTopicAnchorRange: (topic: string, fromHeight: number, toHeight: number) => Promise<any>
  provideAdmittedList: (topic: string, blockHeight: number, blockHash?: string) => Promise<any>
  provideCompoundMerklePath: (topic: string, blockHeight: number, txids: string[]) => Promise<any>
  provideRawTransactions: (txids: string[]) => Promise<any>
  startBASMSync: () => Promise<any>
  advanceTopicAnchorChains: (toHeight?: number) => Promise<void>
  evictUnprovenTransactions: (options?: { topic?: string, thresholdBlocks?: number }) => Promise<any>
  refreshUnprovenTransactionProofs: (options: {
    topic?: string
    thresholdBlocks?: number
    proofProvider: (txid: string) => Promise<{ merklePath: MerklePath, blockHeight?: number } | undefined>
  }) => Promise<any>
  maintainUnprovenTransactions: (options: {
    topic?: string
    thresholdBlocks?: number
    proofProvider: (txid: string) => Promise<{ merklePath: MerklePath, blockHeight?: number } | undefined>
  }) => Promise<any>
  evictAppliedTransaction: (txid: string, options?: { topic?: string, reason?: string }) => Promise<any>
  handleReorg: (input: ReorgHandlerInput) => Promise<any>
  revalidateRecentAnchors: (depth?: number) => Promise<any>
}

class PublicRequestError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'PublicRequestError'
  }
}

function publicErrorMessage (
  error: unknown,
  fallback: string = 'Request could not be processed'
): string {
  return error instanceof PublicRequestError ? error.message : fallback
}

function secretMatches (provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

function parseTopicsHeader (header: string): string[] {
  const value = header.trim()
  let parsed: unknown
  try {
    parsed = value.startsWith('[')
      ? JSON.parse(value)
      : value.split(',').map(topic => topic.trim())
  } catch {
    throw new PublicRequestError(
      'Invalid x-topics header: expected a comma-separated list or JSON string array'
    )
  }

  if (!Array.isArray(parsed) || parsed.some(topic => typeof topic !== 'string' || topic.length === 0)) {
    throw new PublicRequestError(
      'Invalid x-topics header: expected a comma-separated list or JSON string array'
    )
  }
  return parsed
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

  // Enable BRC-136 BASM sync. Off by default; endpoints remain available when
  // storage supports anchors.
  enableBASMSync: boolean = false

  // Opt-in unproven eviction default threshold in blocks.
  unprovenEvictionBlocks: number = 144

  // How often (ms) to poll the chain tip and extend each topic's BASM anchor
  // chain with empty anchors, so the cumulative TAC advances "after each new
  // block" per BRC-136. Set to 0 to disable polling (startup extension still runs).
  basmBlockPollIntervalMs: number = 10 * 60 * 1000

  // Handle for the BASM block-poll timer so it can be stopped.
  private basmBlockPollTimer?: ReturnType<typeof setInterval>

  // How often (ms) to refresh proofs for old unproven rows and then evict rows
  // that still have no proof. Set to 0 to disable background maintenance.
  unprovenMaintenanceIntervalMs: number = 0

  private unprovenMaintenanceTimer?: ReturnType<typeof setInterval>

  // Optional go-chaintracks (Arcade) reorg SSE URL (e.g. `<base>/v2/reorg/stream`).
  // When set, reorgs are reconciled in real time; the block poll also runs a
  // revalidation sweep as a fallback / reconnect catch-up.
  reorgStreamUrl?: string

  // Depth (in blocks from the tip) for the reorg revalidation sweep.
  reorgScanDepth: number = 3

  // Handle for the reorg SSE adapter.
  private reorgAdapter?: ReorgSseAdapter

  // Optional resolver for block hashes and header merkle roots used by BASM.
  topicAnchorHeaderResolver?: TopicAnchorHeaderResolver

  // ARC API Key
  arcApiKey: string | undefined = undefined

  // Optional ARC callback token for /arc-ingest notifications
  arcCallbackToken: string | undefined = undefined

  // Optional Arcade URL/API key used for propagation, proof refresh, and
  // go-chaintracks header/reorg access when available.
  arcadeUrl: string | undefined = undefined
  arcadeApiKey: string | undefined = undefined
  arcadeDeploymentId: string | undefined = undefined
  arcadeChaintracksApiPrefix: string = '/chaintracks/v2'

  private arcadeProvider?: ArcadeProvider

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
    allowPrivateHosts: boolean
  } = {
      requestTimeoutMs: 10000, // 10 seconds
      hostDownRevokeScore: 3,
      autoBanOnRemoval: true,
      allowPrivateHosts: false
    }

  // Ban service for persistent domain/outpoint blocking
  banService?: BanService

  // Admin identity key for wallet-based admin detection on the frontend
  adminIdentityKey?: string

  // Server-side wallet (WalletInterface) used for BSV mutual authentication
  serverWallet?: WalletInterface

  // Optional shared store for BSV mutual-auth sessions.
  authSessionManager?: SessionManager | AsyncSessionManager

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

  // Active HTTP server, retained so timeout policy is observable and the
  // process can add graceful-close handling without replacing app.listen().
  server?: Server

  edgePolicyConfig: EdgePolicyConfig = {
    environmentPrefix: 'OVERLAY',
    jsonBodyLimitBytes: 8 * 1024 * 1024,
    binaryBodyLimitBytes: 64 * 1024 * 1024,
    maxConcurrentRequests: 200,
    http: {
      requestTimeoutMs: 2 * 60 * 1000,
      headersTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
      socketTimeoutMs: 2 * 60 * 1000,
      maxRequestsPerSocket: 1_000
    },
    securityHeaders: {
      contentSecurityPolicy: "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https://bsvblockchain.org; connect-src 'self' https:; font-src 'self' https://cdn.jsdelivr.net; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  }

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
   *   - allowPrivateHosts: Permit private/HTTP targets for isolated local development (default: false)
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
   * Configures explicit browser origins and bounded request/resource policy.
   * Public cross-origin access is the default; pass allowedOrigins or set
   * OVERLAY_CORS_MODE=allowlist to restrict browser callers.
   */
  configureEdgePolicy (config: Partial<Omit<EdgePolicyConfig, 'http' | 'securityHeaders'>> & {
    http?: Partial<HttpServerPolicyDefaults>
    securityHeaders?: SecurityHeadersOptions
  }): void {
    const { http, securityHeaders: headerConfig, ...topLevel } = config
    const definedTopLevel = Object.fromEntries(
      Object.entries(topLevel).filter(([, value]) => value !== undefined)
    ) as Partial<Omit<EdgePolicyConfig, 'http' | 'securityHeaders'>>
    const definedHttp = Object.fromEntries(
      Object.entries(http ?? {}).filter(([, value]) => value !== undefined)
    ) as Partial<HttpServerPolicyDefaults>
    const definedHeaders = Object.fromEntries(
      Object.entries(headerConfig ?? {}).filter(([, value]) => value !== undefined)
    ) as SecurityHeadersOptions
    this.edgePolicyConfig = {
      ...this.edgePolicyConfig,
      ...definedTopLevel,
      http: {
        ...this.edgePolicyConfig.http,
        ...definedHttp
      },
      securityHeaders: {
        ...this.edgePolicyConfig.securityHeaders,
        ...definedHeaders
      }
    }
    this.logger.log(chalk.blue('HTTP edge policy has been configured.'))
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
   * Configures BRC-103 session storage for the administrative mutual-auth
   * middleware. Horizontally scaled services should supply a shared
   * AsyncSessionManager rather than use the default process-local store.
   */
  configureAuthSessionManager (sessionManager: SessionManager | AsyncSessionManager): void {
    this.authSessionManager = sessionManager
    this.logger.log(chalk.blue('BSV authentication session manager has been configured.'))
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
   * Configures the ARC callback token expected by /arc-ingest.
   * @param token - The token ARC should present when posting callback notifications.
   */
  configureArcCallbackToken (token: string): void {
    this.arcCallbackToken = token
    this.logger.log(chalk.blue('ARC callback token has been configured.'))
  }

  /**
   * Configures Arcade for first-choice transaction propagation and proof lookup.
   */
  configureArcade (url: string, config: {
    apiKey?: string
    deploymentId?: string
    chaintracksApiPrefix?: string
  } = {}): void {
    this.arcadeUrl = url
    this.arcadeApiKey = config.apiKey
    this.arcadeDeploymentId = config.deploymentId
    if (config.chaintracksApiPrefix !== undefined) {
      this.arcadeChaintracksApiPrefix = config.chaintracksApiPrefix
    }
    this.logger.log(chalk.blue('Arcade provider has been configured.'))
  }

  /**
   * Configures a go-chaintracks compatible service for header validation and
   * BASM reorg streaming. Arcade exposes this at `/chaintracks/v2`.
   */
  configureChaintracks (url: string, config: {
    apiPrefix?: string
    reorgStream?: boolean
    scanDepth?: number
  } = {}): void {
    const apiPrefix = config.apiPrefix ?? '/chaintracks/v2'
    const client = new ChaintracksProvider(url, { apiPrefix })
    this.configureChainTracker(client)
    this.configureTopicAnchorHeaderResolver(async blockHeight => {
      const header = await client.findHeaderForHeight(blockHeight)
      if (header === undefined) return undefined
      return {
        blockHeight,
        blockHash: header.hash,
        merkleRoot: header.merkleRoot
      }
    })
    if (config.reorgStream !== false) {
      this.configureReorgStream(client.reorgStreamUrl(), config.scanDepth)
    }
    this.logger.log(chalk.blue('go-chaintracks provider has been configured.'))
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
   * Enables or disables BRC-136 BASM synchronization.
   * BASM is opt-in because it requires direct proofs and block hash resolution.
   */
  configureEnableBASMSync (enable: boolean): void {
    this.enableBASMSync = enable
    this.logger.log(chalk.blue(`BASM synchronization ${enable ? 'enabled' : 'disabled'}.`))
  }

  /**
   * Configures the block header resolver used to derive BASM block hashes.
   */
  configureTopicAnchorHeaderResolver (resolver: TopicAnchorHeaderResolver): void {
    this.topicAnchorHeaderResolver = resolver
    this.logger.log(chalk.blue('BASM topic anchor header resolver has been configured.'))
  }

  /**
   * Configures the go-chaintracks (Arcade) reorg SSE stream used to reconcile
   * BASM anchors with blockchain reorganizations in real time.
   * @param url - The reorg stream URL, e.g. `https://arcade.example/v2/reorg/stream`.
   * @param scanDepth - Optional revalidation-sweep depth in blocks (default 3).
   */
  configureReorgStream (url: string, scanDepth?: number): void {
    this.reorgStreamUrl = url
    if (scanDepth !== undefined) {
      this.reorgScanDepth = scanDepth
    }
    this.logger.log(chalk.blue('BASM reorg stream has been configured.'))
  }

  /**
   * Configures the opt-in unproven state eviction threshold.
   */
  configureUnprovenEviction (config: { thresholdBlocks?: number }): void {
    if (config.thresholdBlocks !== undefined) {
      this.unprovenEvictionBlocks = config.thresholdBlocks
    }
    this.logger.log(chalk.blue('Unproven transaction eviction has been configured.'))
  }

  /**
   * Configures periodic unproven maintenance. Each run first tries configured
   * proof providers, then evicts rows that are still unproven past the threshold.
   */
  configureUnprovenMaintenance (config: { intervalMs?: number, thresholdBlocks?: number }): void {
    if (config.intervalMs !== undefined) {
      this.unprovenMaintenanceIntervalMs = config.intervalMs
    }
    if (config.thresholdBlocks !== undefined) {
      this.unprovenEvictionBlocks = config.thresholdBlocks
    }
    this.logger.log(chalk.blue('Unproven transaction maintenance has been configured.'))
  }

  /**
   * Configures how often the BASM anchor chain is extended with empty anchors to
   * follow the chain tip. Set to 0 to disable periodic polling.
   */
  configureBASMBlockPollInterval (intervalMs: number): void {
    this.basmBlockPollIntervalMs = intervalMs
    this.logger.log(chalk.blue(`BASM block poll interval set to ${intervalMs}ms.`))
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
   * @param config - Knex configuration object, or a MySQL connection string loaded from configuration.
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
   * When a BanService is available (from configureMongo), auto-configured SHIP
   * and SLAP managers, discovery storage, and lookup services are wrapped so
   * banned outputs are not admitted or indexed.
   *
   * @param autoConfigureShipSlap - Whether to auto-configure SHIP and SLAP services (default: true)
   */
  async configureEngine (autoConfigureShipSlap = true): Promise<void> {
    const knex = this.ensureKnex()

    if (autoConfigureShipSlap) {
      const mongoDb = this.ensureMongo()
      const shipStorage = new DiscoveryServices.SHIPStorage(mongoDb)
      const slapStorage = new DiscoveryServices.SLAPStorage(mongoDb)

      // Run the one-time discovery migration before the engine can accept
      // traffic, so a failed unique-index build is a visible startup failure.
      await shipStorage.ensureIndexes()
      await slapStorage.ensureIndexes()

      this.configureTopicManager('tm_ship', new DiscoveryServices.SHIPTopicManager())
      this.configureTopicManager('tm_slap', new DiscoveryServices.SLAPTopicManager())

      const shipStorageForLookup = this.banService === undefined
        ? shipStorage
        : new BanAwareSHIPStorage(shipStorage, this.banService, this.logger)
      const slapStorageForLookup = this.banService === undefined
        ? slapStorage
        : new BanAwareSLAPStorage(slapStorage, this.banService, this.logger)

      this.services.ls_ship = new DiscoveryServices.SHIPLookupService(shipStorageForLookup as any)
      this.services.ls_slap = new DiscoveryServices.SLAPLookupService(slapStorageForLookup as any)
      this.logger.log(chalk.blue('Configured lookup service ls_ship with MongoDB'))
      this.logger.log(chalk.blue('Configured lookup service ls_slap with MongoDB'))
    }

    this.wrapBanAwareServices()

    const syncConfig = this.buildSyncConfig()
    const storage = new KnexStorage(knex)
    this.migrationsToRun = [...KnexStorageMigrations.default, ...this.migrationsToRun]

    const broadcaster = this.buildBroadcaster()
    const advertiser = await this.buildAdvertiser()

    const EngineWithBASM = Engine as unknown as new (...args: any[]) => Engine
    this.engine = new EngineWithBASM(
      this.managers,
      this.services,
      storage,
      this.engineConfig.chainTracker ?? this.chainTracker,
      `https://${this.advertisableFQDN}`,
      this.network === 'test'
        ? (this.engineConfig.shipTrackers ?? DEFAULT_TESTNET_SLAP_TRACKERS)
        : this.engineConfig.shipTrackers,
      this.resolveSlapTrackers(),
      broadcaster ?? this.engineConfig.broadcaster,
      advertiser,
      syncConfig,
      this.engineConfig.logTime ?? false,
      this.engineConfig.logPrefix ?? '[OVERLAY_ENGINE] ',
      this.engineConfig.throwOnBroadcastFailure ?? true,
      this.engineConfig.overlayBroadcastFacilitator ?? new HTTPSOverlayBroadcastFacilitator(),
      this.logger,
      this.engineConfig.suppressDefaultSyncAdvertisements ?? true,
      this.buildTopicAnchorHeaderResolver(),
      this.engineConfig.enableBASMSync ?? this.enableBASMSync,
      this.engineConfig.unprovenEvictionBlocks ?? this.unprovenEvictionBlocks
    )

    this.initServerWallet()
    this.logger.log(chalk.green('Engine has been configured.'))
  }

  /** Wrap SHIP/SLAP managers and services with ban-aware filters if BanService is configured. */
  private wrapBanAwareServices (): void {
    if (this.banService === undefined) return
    for (const key of ['tm_ship', 'tm_slap'] as const) {
      if (this.managers[key] !== undefined) {
        const label = key === 'tm_ship' ? 'SHIP' : 'SLAP'
        this.managers[key] = new BanAwareTopicManager(this.managers[key], this.banService, label, this.logger)
        this.logger.log(chalk.blue(`${label} topic manager wrapped with ban-aware filter.`))
      }
    }
    for (const key of ['ls_ship', 'ls_slap'] as const) {
      if (this.services[key] !== undefined) {
        const label = key === 'ls_ship' ? 'SHIP' : 'SLAP'
        this.services[key] = new BanAwareLookupWrapper(this.services[key], this.banService, label, this.logger)
        this.logger.log(chalk.blue(`${label} lookup service wrapped with ban-aware filter.`))
      }
    }
  }

  /** Build the sync config based on enableGASPSync and engineConfig. */
  private buildSyncConfig (): Record<string, string[] | 'SHIP' | false> {
    if (this.enableGASPSync) {
      return this.engineConfig.syncConfiguration ?? {}
    }
    const syncConfig: Record<string, string[] | 'SHIP' | false> = {}
    for (const name of Object.keys(this.managers)) {
      syncConfig[name] = false
    }
    return syncConfig
  }

  /** Build the configured transaction propagation provider chain. */
  private buildBroadcaster (): Broadcaster | undefined {
    const providers: NamedBroadcaster[] = []
    const callbackUrl = `https://${this.advertisableFQDN}/arc-ingest`

    if (typeof this.arcadeUrl === 'string' && this.arcadeUrl.length > 0) {
      this.arcadeProvider = new ArcadeProvider(this.arcadeUrl, {
        apiKey: this.arcadeApiKey,
        callbackUrl,
        callbackToken: this.arcCallbackToken,
        deploymentId: this.arcadeDeploymentId
      })
      providers.push({
        name: 'Arcade',
        broadcaster: this.arcadeProvider
      })
    } else {
      this.arcadeProvider = undefined
    }

    if (typeof this.arcApiKey === 'string' && this.arcApiKey.length > 0) {
      const arcUrl = this.network === 'test' ? 'https://arc-test.taal.com' : 'https://arc.taal.com'
      providers.push({
        name: 'ARC',
        broadcaster: new ARC(arcUrl, {
          apiKey: this.arcApiKey,
          callbackUrl,
          callbackToken: this.arcCallbackToken
        })
      })
    }

    if (providers.length === 0) return undefined
    if (providers.length === 1) return providers[0].broadcaster
    return new ProviderChainBroadcaster(providers)
  }

  private ensureArcadeProvider (): ArcadeProvider | undefined {
    if (this.arcadeProvider !== undefined) return this.arcadeProvider
    if (typeof this.arcadeUrl !== 'string' || this.arcadeUrl.length === 0) return undefined
    this.arcadeProvider = new ArcadeProvider(this.arcadeUrl, {
      apiKey: this.arcadeApiKey,
      callbackUrl: `https://${this.advertisableFQDN}/arc-ingest`,
      callbackToken: this.arcCallbackToken,
      deploymentId: this.arcadeDeploymentId
    })
    return this.arcadeProvider
  }

  private async fetchArcadeProof (txid: string): Promise<ArcadeMerkleProof | undefined> {
    const provider = this.ensureArcadeProvider()
    if (provider === undefined) return undefined
    const proof = await provider.fetchMerkleProof(txid)
    if (proof === undefined) return undefined
    const chainTracker = this.engineConfig.chainTracker ?? this.chainTracker
    if (chainTracker === 'scripts only') {
      throw new Error('Cannot validate Arcade proof with scripts-only chain tracker')
    }
    const blockHeight = proof.blockHeight ?? proof.merklePath.blockHeight
    if (blockHeight === undefined) {
      throw new Error(`Arcade proof for ${txid} did not include a block height`)
    }
    const valid = await chainTracker.isValidRootForHeight(proof.merkleRoot, blockHeight)
    if (!valid) {
      throw new Error(`Arcade proof for ${txid} did not match the chain tracker at height ${blockHeight}`)
    }
    return {
      ...proof,
      blockHeight
    }
  }

  private async fetchConfiguredMerkleProof (txid: string): Promise<{ merklePath: MerklePath, blockHeight?: number } | undefined> {
    const proof = await this.fetchArcadeProof(txid)
    if (proof === undefined) return undefined
    return {
      merklePath: proof.merklePath,
      blockHeight: proof.blockHeight
    }
  }

  /** Build the BASM block header resolver. */
  private buildTopicAnchorHeaderResolver (): TopicAnchorHeaderResolver | undefined {
    const configured = this.engineConfig.topicAnchorHeaderResolver ?? this.topicAnchorHeaderResolver
    if (configured !== undefined) {
      return configured
    }

    return async (blockHeight: number) => {
      const response = await fetch(`https://api.whatsonchain.com/v1/bsv/${this.network}/block/${blockHeight}/header`, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      })
      if (!response.ok) {
        throw new Error(`WhatsOnChain header lookup failed for height ${blockHeight}: ${response.status}`)
      }
      const header = await response.json() as { hash?: string, merkleroot?: string }
      if (typeof header.hash !== 'string') {
        throw new TypeError(`WhatsOnChain did not return a block hash for height ${blockHeight}`)
      }
      return {
        blockHeight,
        blockHash: header.hash,
        merkleRoot: header.merkleroot
      }
    }
  }

  /** Resolve the SLAP trackers from config or network defaults. */
  private resolveSlapTrackers (): string[] | undefined {
    if (Array.isArray(this.engineConfig.slapTrackers)) return this.engineConfig.slapTrackers
    return this.network === 'test' ? DEFAULT_TESTNET_SLAP_TRACKERS : DEFAULT_SLAP_TRACKERS
  }

  /** Build the WalletAdvertiser (or use user-provided one). */
  private async buildAdvertiser (): Promise<Advertiser | undefined> {
    if (this.engineConfig.advertiser !== undefined) return this.engineConfig.advertiser
    const storageBase = this.network === 'test'
      ? 'https://staging-storage.babbage.systems'
      : 'https://storage.babbage.systems'
    try {
      return new DiscoveryServices.WalletAdvertiser(
        this.network,
        this.privateKey,
        storageBase,
        `https://${this.advertisableFQDN}`
      )
    } catch (e) {
      this.logger.log(`Advertiser not initialized for FQDN ${this.advertisableFQDN} - SHIP and SLAP will be disabled. Reason: ${e}`)
      return undefined
    }
  }

  /** Initialize the server wallet for BSV mutual authentication. */
  private initServerWallet (): void {
    try {
      const keyDeriver = new KeyDeriver(new PrivateKey(this.privateKey, 'hex'))
      const storageManager = new WalletStorageManager(keyDeriver.identityKey)
      const signer = new WalletSigner(this.network, keyDeriver, storageManager)
      const services = new Services(this.network)
      this.serverWallet = new Wallet(signer, services)
      this.adminIdentityKey ??= keyDeriver.identityKey
      this.logger.log(chalk.blue('Server wallet initialized for BSV mutual authentication.'))
    } catch (e) {
      this.logger.log(chalk.yellow(`Server wallet could not be initialized. BSV auth will not be available. Reason: ${e}`))
    }
  }

  /**
   * Ensures that Knex is configured and returns it.
   * @throws Error if Knex is not configured
   */
  private ensureKnex (): Knex.Knex {
    if (this.knex === undefined) {
      throw new TypeError('You must configure your SQL database with the .configureKnex() method first!')
    }
    return this.knex
  }

  /**
   * Ensures that MongoDB is configured and returns it.
   * @throws Error if MongoDB is not configured
   */
  private ensureMongo (): Db {
    if (this.mongoDb === undefined) {
      throw new TypeError('You must configure your MongoDB connection with the .configureMongo() method first!')
    }
    return this.mongoDb
  }

  /**
   * Ensures that the Overlay Engine is configured and returns it.
   * @throws Error if the Engine is not configured
   */
  private ensureEngine (): Engine {
    if (this.engine === undefined) {
      throw new TypeError('You must configure your Overlay Services engine with the .configureEngine() method first!')
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
      autoBanOnRemoval: this.janitorConfig.autoBanOnRemoval,
      allowPrivateHosts: this.janitorConfig.allowPrivateHosts
    })
  }

  /** Ban a domain and remove all its SHIP/SLAP records from MongoDB. */
  private async handleBanDomain (res: express.Response, value: string, reason?: string): Promise<express.Response> {
    await this.banService!.banDomain(value, reason)
    const db = this.ensureMongo()
    const [shipDeleted, slapDeleted] = await Promise.all([
      db.collection('shipRecords').deleteMany({ domain: value }),
      db.collection('slapRecords').deleteMany({ domain: value })
    ])
    return res.status(200).json({
      status: 'success',
      message: `Domain "${value}" banned. Removed ${shipDeleted.deletedCount} SHIP and ${slapDeleted.deletedCount} SLAP records.`
    })
  }

  /** Parse outpoint string, ban it, and evict it from all lookup services. */
  private async handleBanOutpoint (res: express.Response, engine: Engine, value: string, reason?: string): Promise<express.Response> {
    const dotIndex = value.lastIndexOf('.')
    if (dotIndex === -1) {
      return res.status(400).json({ status: 'error', message: 'Outpoint format must be "txid.outputIndex"' })
    }
    const txid = value.substring(0, dotIndex)
    const outputIndex = Number.parseInt(value.substring(dotIndex + 1))
    if (Number.isNaN(outputIndex)) {
      return res.status(400).json({ status: 'error', message: 'Invalid outputIndex in outpoint' })
    }
    await this.banService!.banOutpoint(txid, outputIndex, reason)
    await this.evictFromServices(engine, txid, outputIndex)
    return res.status(200).json({
      status: 'success',
      message: `Outpoint "${value}" banned and evicted from lookup services.`
    })
  }

  /** Evict an output from a specific service or all services (silent per-service errors). */
  private async evictFromServices (engine: Engine, txid: string, outputIndex: number, service?: string): Promise<void> {
    if (typeof service === 'string') {
      const svc = engine.lookupServices[service]
      if (svc !== undefined) await svc.outputEvicted(txid, outputIndex)
      return
    }
    for (const svc of Object.values(engine.lookupServices)) {
      try { await svc.outputEvicted(txid, outputIndex) } catch { /* best-effort */ }
    }
  }

  /** Look up the domain of an outpoint from SHIP or SLAP records. */
  private async lookupDomainForOutpoint (txid: string, outputIndex: number): Promise<string | undefined> {
    const db = this.ensureMongo()
    const [shipRecord, slapRecord] = await Promise.all([
      db.collection('shipRecords').findOne({ txid, outputIndex }),
      db.collection('slapRecords').findOne({ txid, outputIndex })
    ])
    return (shipRecord?.domain ?? slapRecord?.domain) as string | undefined
  }

  /** Ban a domain and delete all SHIP/SLAP records for it. */
  private async banDomainAndRemoveRecords (domain: string, reason: string): Promise<void> {
    await this.banService!.banDomain(domain, reason)
    const db = this.ensureMongo()
    await Promise.all([
      db.collection('shipRecords').deleteMany({ domain }),
      db.collection('slapRecords').deleteMany({ domain })
    ])
  }

  private async runHealthCheck (
    definition: Required<Pick<HealthCheckDefinition, 'name' | 'scope' | 'critical'>> & { handler: HealthCheckHandler }
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now()
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      const result = ((await Promise.race([
        Promise.resolve(definition.handler()),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Timed out after ${this.healthConfig.timeoutMs}ms`)),
            this.healthConfig.timeoutMs
          )
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
      this.logger.error({
        operation: 'overlay.health_check',
        check: definition.name,
        error
      })
      return {
        name: definition.name,
        scope: definition.scope,
        critical: definition.critical,
        status: 'error',
        message: 'Health check failed',
        durationMs: Date.now() - startedAt
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
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
          if (this.engine === undefined) {
            throw new TypeError('Overlay engine is not configured')
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
          if (this.knex === undefined) {
            throw new TypeError('Knex is not configured')
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
          if (this.mongoDb === undefined) {
            throw new TypeError('MongoDB is not configured')
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
        uptimeMs: this.startTime === undefined ? 0 : Date.now() - this.startTime.getTime(),
        topicManagerCount: Object.keys(this.managers).length,
        lookupServiceCount: Object.keys(this.services).length
      },
      checks: this.healthConfig.includeDetails
        ? checks
        : checks.map(check => {
            const publicCheck = { ...check }
            delete publicCheck.details
            return publicCheck
          }),
      context
    }

    return report
  }

  /**
   * Renders a request or response body for verbose logging, truncating overly long payloads.
   */
  private formatBodyForLog (body: any, okPrefix: string): string {
    if (Buffer.isBuffer(body)) {
      return chalk.green(`${okPrefix} binary body (${serializeLogValue(body.byteLength)} bytes)`)
    }
    if (typeof body === 'string') {
      return chalk.green(`${okPrefix} string body (${serializeLogValue(Buffer.byteLength(body, 'utf8'))} bytes)`)
    }
    if (body != null && typeof body === 'object') {
      const keys = Array.isArray(body) ? body.length : Object.keys(body).length
      return chalk.green(`${okPrefix} structured body (${serializeLogValue(keys)} top-level item(s))`)
    }
    return chalk.green(`${okPrefix} type=${serializeLogValue(typeof body)}`)
  }

  private redactHeadersForLog (headers: Record<string, any>): Record<string, any> {
    const sensitiveHeader = /authorization|cookie|token|secret|payment|signature|nonce/i
    return Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        sensitiveHeader.test(name) ? '[REDACTED]' : value
      ])
    )
  }

  private arcCallbackRequestToken(req: Request): string | undefined {
    const authorization = req.headers.authorization
    const headerToken = Array.isArray(authorization) ? authorization[0] : authorization
    if (typeof headerToken === 'string' && headerToken.startsWith('Bearer ')) {
      return headerToken.slice('Bearer '.length)
    }
    return headerToken
  }

  private arcCallbackAuthorized(req: Request): boolean {
    if (typeof this.arcCallbackToken !== 'string' || this.arcCallbackToken.length === 0) {
      return true
    }
    const callbackHeader = req.headers['x-callback-token']
    const callbackToken = Array.isArray(callbackHeader) ? callbackHeader[0] : callbackHeader
    return (
      this.arcCallbackRequestToken(req) === this.arcCallbackToken ||
      callbackToken === this.arcCallbackToken
    )
  }

  private async processArcIngest(engine: Engine, req: Request, res: Response): Promise<Response> {
    if (!this.arcCallbackAuthorized(req)) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized callback' })
    }
    const {
      txid,
      merklePath: merklePathHex,
      blockHeight,
      txStatus,
      extraInfo,
      competingTxs,
      topic
    } = req.body
    if (typeof txid !== 'string' || txid === '') {
      throw new PublicRequestError('Provider callback is missing txid')
    }
    if (isTerminalArcStatus(txStatus, extraInfo)) {
      const report = await (engine as BASMCapableEngine).evictAppliedTransaction(txid, {
        topic: typeof topic === 'string' ? topic : undefined,
        reason: `${txStatus ?? ''} ${extraInfo ?? ''}`.trim()
      })
      this.logger.warn({
        operation: 'overlay.provider_callback',
        outcome: 'terminal_evicted',
        txid,
        txStatus,
        competingTxs,
        report
      })
      return res.status(200).json({
        status: 'success',
        message: 'Terminal transaction status processed',
        data: { ...report, txStatus, competingTxs }
      })
    }
    if (typeof merklePathHex !== 'string' || merklePathHex === '') {
      return res
        .status(202)
        .json({ status: 'success', message: 'Transaction status received without proof' })
    }
    await engine.handleNewMerkleProof(txid, MerklePath.fromHex(merklePathHex), blockHeight)
    this.logger.log({
      operation: 'overlay.provider_callback',
      outcome: 'proof_ingested',
      txid,
      blockHeight
    })
    return res.status(200).json({ status: 'success', message: 'Transaction status updated' })
  }

  /**
   * Installs middleware that verbosely logs incoming requests and outgoing responses.
   */
  private setupVerboseRequestLogging (): void {
    this.app.use((req, res, next) => {
      const startTime = Date.now()

      // Log incoming request details
      this.logger.log(chalk.magenta.bold(`Incoming Request: method=${serializeLogValue(req.method)} url=${serializeLogValue(req.originalUrl)}`))
      this.logger.log(chalk.cyan(`Headers: ${serializeLogValue(this.redactHeadersForLog(req.headers))}`))

      // Handle request body
      if (req.body != null && Object.keys(req.body).length > 0) {
        this.logger.log(this.formatBodyForLog(req.body, 'Request Body:'))
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
            `Outgoing Response: method=${serializeLogValue(req.method)} url=${serializeLogValue(req.originalUrl)} status=${serializeLogValue(res.statusCode)} durationMs=${serializeLogValue(duration)}`
          )
        )
        this.logger.log(chalk.cyan(`Response Headers: ${serializeLogValue(this.redactHeadersForLog(res.getHeaders()))}`))

        // Handle response body
        if (responseBody != null) {
          this.logger.log(this.formatBodyForLog(responseBody, 'Response Body:'))
        }
      })

      next()
    })
  }

  /**
   * Starts the Express server.
   * Sets up routes and begins listening on the configured port.
   */
  async start (): Promise<void> {
    const engine = this.ensureEngine()
    const knex = this.ensureKnex()
    this.startTime = new Date()

    const edgePolicy = this.edgePolicyConfig
    this.app.disable('x-powered-by')
    this.app.use(securityHeaders({
      environmentPrefix: edgePolicy.environmentPrefix,
      ...edgePolicy.securityHeaders
    }))
    this.app.use(corsPolicy({
      environmentPrefix: edgePolicy.environmentPrefix,
      allowedOrigins: edgePolicy.allowedOrigins,
      methods: ['GET', 'POST', 'OPTIONS']
    }))
    this.app.use(concurrencyLimit(
      edgePolicy.environmentPrefix,
      edgePolicy.maxConcurrentRequests
    ))
    this.app.use(bodyParser.json({
      limit: readBodyLimitBytes(
        `${edgePolicy.environmentPrefix}_JSON`,
        edgePolicy.jsonBodyLimitBytes
      ),
      type: 'application/json'
    }))
    this.app.use(bodyParser.raw({
      limit: readBodyLimitBytes(
        `${edgePolicy.environmentPrefix}_BINARY`,
        edgePolicy.binaryBodyLimitBytes
      ),
      type: 'application/octet-stream'
    }))
    this.app.use(bodyParserErrorHandler)

    if (this.verboseRequestLogging) {
      this.setupVerboseRequestLogging()
    }

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
        this.logger.error({ operation: 'overlay.health_live', error })
        res.status(500).json({
          status: 'error',
          message: 'Health report unavailable'
        })
      })
    })

    this.app.get('/health/ready', (_, res) => {
      ; (async () => {
        const report = await this.collectHealthReport('ready')
        return res.status(report.ready ? 200 : 503).json(report)
      })().catch((error) => {
        this.logger.error({ operation: 'overlay.health_ready', error })
        res.status(500).json({
          status: 'error',
          message: 'Health report unavailable'
        })
      })
    })

    this.app.get('/health', (_, res) => {
      ; (async () => {
        const report = await this.collectHealthReport('full')
        return res.status(report.ready ? 200 : 503).json(report)
      })().catch((error) => {
        this.logger.error({ operation: 'overlay.health_full', error })
        res.status(500).json({
          status: 'error',
          message: 'Health report unavailable'
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
            message: publicErrorMessage(error)
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
            message: publicErrorMessage(error)
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
            message: publicErrorMessage(error)
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
            message: publicErrorMessage(error)
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
            throw new PublicRequestError('Missing x-topics header')
          }
          const topics = parseTopicsHeader(topicsHeader)
          const body = req.body
          if (body == null || typeof body[Symbol.iterator] !== 'function' || body.length === 0) {
            throw new PublicRequestError('Missing or empty BEEF body')
          }
          let offChainValues: number[] | undefined
          let beef = Array.from(body as number[])
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
          this.logger.error(chalk.red(`Error in /submit: error=${serializeErrorForLog(error)}`))
          return res.status(400).json({
            status: 'error',
            message: publicErrorMessage(error)
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
          this.logger.error(chalk.red(`Error in /lookup: error=${serializeErrorForLog(error)}`))
          return res.status(400).json({
            status: 'error',
            message: publicErrorMessage(error)
          })
        }
      })().catch(() => {
        res.status(500).json({
          status: 'error',
          message: 'Unexpected error'
        })
      })
    })

    // ARC/Arcade ingest route (only if a provider is configured)
    if (
      (typeof this.arcApiKey === 'string' && this.arcApiKey.length > 0) ||
      (typeof this.arcadeUrl === 'string' && this.arcadeUrl.length > 0)
    ) {
      this.app.post('/arc-ingest', (req, res) => {
        ; (async () => {
          try {
            return await this.processArcIngest(engine, req, res)
          } catch (error) {
            this.logger.error(chalk.red(`Error in /arc-ingest: error=${serializeErrorForLog(error)}`))
            return res.status(400).json({
              status: 'error',
              message: publicErrorMessage(error)
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
      this.logger.warn(chalk.yellow('Disabling ARC/Arcade ingest because no provider was configured.'))
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
              message: publicErrorMessage(error)
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
              message: publicErrorMessage(error)
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

    // BRC-136 BASM anchor and raw transaction endpoints.
    const basmEngine = engine as BASMCapableEngine
    const readBasmTopic = (req: express.Request): string => {
      const header = req.headers['x-bsv-topic']
      if (typeof header !== 'string' || header.length === 0) {
        throw new PublicRequestError('Missing x-bsv-topic header')
      }
      return header
    }

    /**
     * Registers a POST route whose handler resolves to the JSON payload returned
     * with HTTP 200. Any thrown error is logged and returned as HTTP 400, while
     * unexpected rejections fall back to HTTP 500. This consolidates the shared
     * async/try-catch boilerplate used by the BRC-136 BASM endpoints (and the
     * BASM-related admin endpoints, which additionally pass `checkAdminAuth`).
     */
    const registerJsonRoute = (
      path: string,
      handler: (req: express.Request) => Promise<unknown>,
      ...middleware: express.RequestHandler[]
    ): void => {
      this.app.post(path, ...(middleware as any[]), (req: express.Request, res: express.Response) => {
        ; (async () => {
          try {
            return res.status(200).json(await handler(req))
          } catch (error) {
            console.error(chalk.red(`Error in ${path}:`), error)
            return res.status(400).json({
              status: 'error',
              message: publicErrorMessage(error)
            })
          }
        })().catch(() => {
          res.status(500).json({ status: 'error', message: 'Unexpected error' })
        })
      })
    }

    const requireTxids = (value: unknown): string[] => {
      if (!Array.isArray(value) || !value.every(txid => typeof txid === 'string')) {
        throw new PublicRequestError('txids must be an array of strings')
      }
      return value
    }

    registerJsonRoute('/requestTopicAnchorTip', async req =>
      await basmEngine.provideTopicAnchorTip(readBasmTopic(req)))

    registerJsonRoute('/requestTopicAnchorRange', async req => {
      const { fromHeight, toHeight } = req.body
      return await basmEngine.provideTopicAnchorRange(readBasmTopic(req), Number(fromHeight), Number(toHeight))
    })

    registerJsonRoute('/requestAdmittedList', async req => {
      const { blockHeight, blockHash } = req.body
      return await basmEngine.provideAdmittedList(
        readBasmTopic(req),
        Number(blockHeight),
        typeof blockHash === 'string' ? blockHash : undefined
      )
    })

    registerJsonRoute('/requestCompoundMerklePath', async req => {
      const topic = readBasmTopic(req)
      const { blockHeight, txids } = req.body
      return await basmEngine.provideCompoundMerklePath(topic, Number(blockHeight), requireTxids(txids))
    })

    registerJsonRoute('/requestRawTransactions', async req =>
      await basmEngine.provideRawTransactions(requireTxids(req.body.txids)))

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
        sessionManager: this.authSessionManager,
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
      const authReq = req as unknown as AuthRequest
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
        if (secretMatches(token, this.adminToken)) {
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
              uptime: this.startTime != null ? Date.now() - this.startTime.getTime() : 0,
              startedAt: this.startTime?.toISOString(),
              shipRecordCount: shipCount,
              slapRecordCount: slapCount,
              bannedDomains: banStats.domainBans,
              bannedOutpoints: banStats.outpointBans,
              totalBans: banStats.totalBans,
              topicManagers: Object.keys(this.managers),
              lookupServices: Object.keys(this.services),
              gaspSyncEnabled: this.enableGASPSync,
              basmSyncEnabled: this.enableBASMSync,
              unprovenEvictionBlocks: this.unprovenEvictionBlocks
            }
          })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: publicErrorMessage(error)
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
          const rawPage = Number.parseInt(req.query.page as string, 10)
          const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage)
          const rawLimit = Number.parseInt(req.query.limit as string, 10)
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
            message: publicErrorMessage(error)
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
          const rawPage = Number.parseInt(req.query.page as string, 10)
          const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage)
          const rawLimit = Number.parseInt(req.query.limit as string, 10)
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
            message: publicErrorMessage(error)
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
          const url = req.body?.url
          if (typeof url !== 'string' || url.length === 0) {
            return res.status(400).json({ status: 'error', message: 'url is required' })
          }
          const janitor = this.createJanitor()
          const result = await janitor.checkHost(url)
          return res.status(200).json({ status: 'success', data: { url, ...result } })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: publicErrorMessage(error)
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
            return await this.handleBanDomain(res, value, reason)
          }
          return await this.handleBanOutpoint(res, engine, value, reason)
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: publicErrorMessage(error)
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
            message: publicErrorMessage(error)
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
            message: publicErrorMessage(error)
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

          // Look up domain before eviction if needed for banning
          let removedDomain: string | undefined
          if (shouldBanDomain === true || ban === true) {
            removedDomain = await this.lookupDomainForOutpoint(txid, outputIndex)
          }

          await this.evictFromServices(engine, txid, outputIndex, service)

          if (ban === true && this.banService !== undefined) {
            await this.banService.banOutpoint(txid, outputIndex, 'Manually removed by admin', removedDomain)
          }

          if (shouldBanDomain === true && typeof removedDomain === 'string' && this.banService !== undefined) {
            await this.banDomainAndRemoveRecords(removedDomain, 'Domain banned by admin via token removal')
          }

          const banMsg = ban === true ? ' Outpoint banned.' : ''
          const domainMsg = shouldBanDomain === true && typeof removedDomain === 'string'
            ? ` Domain "${removedDomain}" banned.`
            : ''
          return res.status(200).json({
            status: 'success',
            message: `Token ${txid}.${outputIndex} removed.${banMsg}${domainMsg}`
          })
        } catch (error) {
          return res.status(400).json({
            status: 'error',
            message: publicErrorMessage(error)
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
            message: publicErrorMessage(error)
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
            message: publicErrorMessage(error)
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
     * Admin route to manually start BASM sync, calling `engine.startBASMSync()`.
     */
    registerJsonRoute('/admin/startBASMSync', async () => {
      const report = await basmEngine.startBASMSync()
      return { status: 'success', message: 'BASM sync started and completed', data: report }
    }, checkAdminAuth as any)

    /**
     * Admin route to evict expired unproven topic transactions.
     */
    registerJsonRoute('/admin/evictUnproven', async req => {
      const { topic, thresholdBlocks } = req.body ?? {}
      const report = await basmEngine.evictUnprovenTransactions({
        topic: typeof topic === 'string' ? topic : undefined,
        thresholdBlocks: typeof thresholdBlocks === 'number' ? thresholdBlocks : undefined
      })
      this.logger.log({ operation: 'overlay.unproven_eviction', outcome: 'ok', report })
      return { status: 'success', message: 'Unproven eviction completed', data: report }
    }, checkAdminAuth as any)

    /**
     * Admin route to refresh proofs for expired unproven topic transactions
     * using the configured proof providers.
     */
    registerJsonRoute('/admin/refreshUnprovenProofs', async req => {
      const { topic, thresholdBlocks } = req.body ?? {}
      const report = await basmEngine.refreshUnprovenTransactionProofs({
        topic: typeof topic === 'string' ? topic : undefined,
        thresholdBlocks: typeof thresholdBlocks === 'number' ? thresholdBlocks : undefined,
        proofProvider: async txid => await this.fetchConfiguredMerkleProof(txid)
      })
      this.logger.log({ operation: 'overlay.unproven_proof_refresh', outcome: 'ok', report })
      return { status: 'success', message: 'Unproven proof refresh completed', data: report }
    }, checkAdminAuth as any)

    /**
     * Admin route to refresh proofs first, then evict rows that remain unproven.
     */
    registerJsonRoute('/admin/maintainUnproven', async req => {
      const { topic, thresholdBlocks } = req.body ?? {}
      const report = await basmEngine.maintainUnprovenTransactions({
        topic: typeof topic === 'string' ? topic : undefined,
        thresholdBlocks: typeof thresholdBlocks === 'number' ? thresholdBlocks : undefined,
        proofProvider: async txid => await this.fetchConfiguredMerkleProof(txid)
      })
      this.logger.log({ operation: 'overlay.unproven_maintenance', outcome: 'ok', report })
      return { status: 'success', message: 'Unproven maintenance completed', data: report }
    }, checkAdminAuth as any)

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
            for (const service of services) {
              try {
                await service.outputEvicted(req.body.txid, req.body.outputIndex)
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
            message: publicErrorMessage(error)
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
            message: publicErrorMessage(error)
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
      this.logger.log(chalk.red(`404 Not Found: url=${serializeLogValue(req.url)}`))
      res.status(404).json({
        status: 'error',
        code: 'ERR_ROUTE_NOT_FOUND',
        description: 'Route not found.'
      })
    })

    await this.runStartupSync()

    // Start listening on the configured port
    this.server = this.app.listen(this.port, () => {
      this.isListening = true
      this.logger.log(chalk.green.bold(`${this.name} is ready and listening on local port ${this.port}`))
    })
    configureHttpServer(
      this.server,
      edgePolicy.environmentPrefix,
      edgePolicy.http
    )
  }

  /**
   * Runs the post-listen startup work: advertiser init, advertisement sync,
   * and the optional GASP/BASM background syncs.
   */
  private async runStartupSync (): Promise<void> {
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

    await this.runGaspStartupSync()
    await this.runBasmStartupSync()
    this.startUnprovenMaintenance()
  }

  /** Attempt a GASP sync at startup when enabled. */
  private async runGaspStartupSync (): Promise<void> {
    if (!this.enableGASPSync) {
      this.logger.log(chalk.yellow(`${this.name} will not sync because GASP has been disabled.`))
      return
    }
    try {
      this.logger.log(chalk.green('Starting GASP sync...'))
      await this.engine?.startGASPSync()
      this.logger.log(chalk.green('GASP sync complete!'))
    } catch (e) {
      console.error(chalk.red('Failed to GASP sync'), e)
    }
  }

  /** Attempt a BASM sync at startup when enabled, then begin tip-following. */
  private async runBasmStartupSync (): Promise<void> {
    if (!(this.enableBASMSync || this.engineConfig.enableBASMSync === true)) {
      return
    }
    try {
      this.logger.log(chalk.green('Starting BASM sync...'))
      const report = await (this.engine as BASMCapableEngine | undefined)?.startBASMSync()
      this.logger.log(chalk.green('BASM sync complete!'), report)
    } catch (e) {
      console.error(chalk.red('Failed to BASM sync'), e)
    }

    // Extend each topic's anchor chain to the current tip on startup, then keep
    // it following the tip so the cumulative TAC advances after each new block.
    await this.advanceBASMAnchorChains()
    this.startBASMBlockPolling()
    this.startBASMReorgStream()
  }

  /** Poll for new blocks to advance anchor chains and detect reorgs. */
  private startBASMBlockPolling (): void {
    if (this.basmBlockPollIntervalMs <= 0) {
      return
    }
    this.basmBlockPollTimer = setInterval(() => {
      void this.advanceBASMAnchorChains()
      // Fallback reorg detection for chain trackers without a reorg stream,
      // and a safety net even when the SSE adapter is active.
      void this.revalidateBASMAnchors()
    }, this.basmBlockPollIntervalMs)
    this.basmBlockPollTimer.unref?.()
  }

  /** Real-time reorg reconciliation via the go-chaintracks (Arcade) reorg SSE. */
  private startBASMReorgStream (): void {
    const reorgStreamUrl = this.engineConfig.reorgStreamUrl ?? this.reorgStreamUrl
    const reorgScanDepth = this.engineConfig.reorgScanDepth ?? this.reorgScanDepth
    if (reorgStreamUrl === undefined || reorgStreamUrl === '') {
      return
    }
    const basmEngine = this.engine as BASMCapableEngine | undefined
    this.reorgAdapter = new ReorgSseAdapter({
      url: reorgStreamUrl,
      onReorg: async input => { await basmEngine?.handleReorg(input) },
      onConnect: async () => { await basmEngine?.revalidateRecentAnchors(reorgScanDepth) },
      logger: this.logger
    })
    this.reorgAdapter.start()
    this.logger.log(chalk.green(`BASM reorg stream listening at ${reorgStreamUrl}`))
  }

  /** Extend every topic's BASM anchor chain to the current chain tip. */
  private async advanceBASMAnchorChains (): Promise<void> {
    try {
      await (this.engine as BASMCapableEngine | undefined)?.advanceTopicAnchorChains()
    } catch (e) {
      console.error(chalk.red('Failed to advance BASM anchor chains'), e)
    }
  }

  /** Revalidate recent BASM anchors against the chain tracker, reconciling any reorg. */
  private async revalidateBASMAnchors (): Promise<void> {
    try {
      const depth = this.engineConfig.reorgScanDepth ?? this.reorgScanDepth
      await (this.engine as BASMCapableEngine | undefined)?.revalidateRecentAnchors(depth)
    } catch (e) {
      console.error(chalk.red('Failed to revalidate BASM anchors'), e)
    }
  }

  private startUnprovenMaintenance (): void {
    const intervalMs = this.engineConfig.unprovenMaintenanceIntervalMs ?? this.unprovenMaintenanceIntervalMs
    if (intervalMs <= 0) return
    const run = (): void => {
      void (async () => {
        try {
          const report = await (this.engine as BASMCapableEngine | undefined)?.maintainUnprovenTransactions({
            thresholdBlocks: this.engineConfig.unprovenEvictionBlocks ?? this.unprovenEvictionBlocks,
            proofProvider: async txid => await this.fetchConfiguredMerkleProof(txid)
          })
          this.logger.log(chalk.green('Unproven transaction maintenance complete'), report)
        } catch (e) {
          console.error(chalk.red('Failed to maintain unproven transactions'), e)
        }
      })()
    }
    run()
    this.unprovenMaintenanceTimer = setInterval(run, intervalMs)
    this.unprovenMaintenanceTimer.unref?.()
  }
}
