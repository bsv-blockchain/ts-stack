import { Reader, Writer } from '@bsv/sdk/primitives/utils'
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
  DEFAULT_TTN_SLAP_TRACKERS,
  DEFAULT_SLAP_TRACKERS,
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
import {
  SHIPLookupService,
  SHIPStorage,
  SHIPTopicManager,
  SLAPLookupService,
  SLAPStorage,
  SLAPTopicManager,
  WalletAdvertiser
} from '@bsv/overlay-discovery-services'
import chalk from 'chalk'
import { v4 as uuidv4 } from 'uuid'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { JanitorService, type JanitorReport } from './JanitorService.js'
import { BanService } from './BanService.js'
import { BanAwareLookupWrapper } from './BanAwareLookupWrapper.js'
import { ResourceBoundedLookupWrapper } from './ResourceBoundedLookupWrapper.js'
import { BanAwareTopicManager } from './BanAwareTopicManager.js'
import { BanAwareSHIPStorage, BanAwareSLAPStorage } from './BanAwareDiscoveryStorage.js'
import { ReorgSseAdapter, type ReorgHandlerInput } from './ReorgStream.js'
import { Wallet, WalletSigner, WalletStorageManager, Services } from '@bsv/wallet-toolbox-client'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import { ArcadeProvider, isTerminalArcStatus, type ArcadeMerkleProof } from './ArcadeProvider.js'
import { ProviderChainBroadcaster, type NamedBroadcaster } from './ProviderChainBroadcaster.js'
import { ChaintracksProvider } from './ChaintracksProvider.js'
import {
  assertBoundedString,
  assertHash,
  assertNonnegativeSafeInteger,
  fetchWithDeadline,
  isRecord,
  readBoundedJson,
  secureServiceFetch
} from './OutboundSecurity.js'
import type { Server } from 'node:http'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  configureHttpServer,
  corsPolicy,
  initialDoubleSlashCompatibility,
  profileValue,
  readBodyLimitBytes,
  readResourceLimit,
  readResourceProfile,
  responseSizeLimit,
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
  constructor(private readonly migrations: Migration[]) {}

  /**
   * Gets the list of migrations.
   * @param loadExtensions - Array of file extensions to filter by (not used here)
   * @returns Promise resolving to the array of migrations
   */
  async getMigrations(_loadExtensions: readonly string[]): Promise<Migration[]> {
    return this.migrations
  }

  /**
   * Gets the name of a migration.
   * @param migration - The migration object
   * @returns The name of the migration
   */
  getMigrationName(migration: Migration): string {
    return typeof migration.name === 'string'
      ? migration.name
      : `Migration at index ${this.migrations.indexOf(migration)}`
  }

  /**
   * Gets the migration object.
   * @param migration - The migration object
   * @returns Promise resolving to the migration object
   */
  async getMigration(migration: Migration): Promise<Knex.Knex.Migration> {
    return await Promise.resolve(migration)
  }
}

/**
 * Configuration options that map to Engine constructor parameters.
 */
export type SyncConfigurationEntry = string[] | 'SHIP' | false
export type SyncConfigurationMap = Record<string, SyncConfigurationEntry>
export type OverlayNetwork = 'main' | 'test' | 'ttn'

export interface EngineConfig {
  chainTracker?: ChainTracker | 'scripts only'
  shipTrackers?: string[]
  slapTrackers?: string[]
  broadcaster?: Broadcaster
  advertiser?: Advertiser
  syncConfiguration?: SyncConfigurationMap
  logTime?: boolean
  logPrefix?: string
  throwOnBroadcastFailure?: boolean
  overlayBroadcastFacilitator?: OverlayBroadcastFacilitator
  suppressDefaultSyncAdvertisements?: boolean
  topicAnchorHeaderResolver?: TopicAnchorHeaderResolver
  enableBASMSync?: boolean
  unprovenEvictionBlocks?: number
  reorgStreamUrl?: string
  reorgStreamAllowPrivateHosts?: boolean
  reorgScanDepth?: number
  unprovenMaintenanceIntervalMs?: number
  /** Maximum lookup formulas hydrated by the engine. Use -1 to opt out. */
  maxLookupResults?: number
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

export type HealthCheckHandler = () =>
  | Promise<Omit<HealthCheckResult, 'name' | 'scope' | 'critical' | 'durationMs'> | void>
  | Omit<HealthCheckResult, 'name' | 'scope' | 'critical' | 'durationMs'>
  | void

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

const MAX_HEALTH_TIMEOUT_MS = 60_000
const MAX_HEALTH_CHECKS = 128
const MAX_HEALTH_NAME_BYTES = 128
const MAX_HEALTH_MESSAGE_BYTES = 1024
const MAX_HEALTH_REPORT_DATA_BYTES = 1024 * 1024
const MIN_SHARED_SECRET_BYTES = 32
const MAX_SHARED_SECRET_BYTES = 16 * 1024
const MAX_BLOCK_HEADER_RESPONSE_BYTES = 64 * 1024
const BLOCK_HEADER_REQUEST_TIMEOUT_MS = 30_000
const MAX_CONFIGURED_BODY_BYTES = 512 * 1024 * 1024
const MAX_CONFIGURED_ORIGINS = 128

export interface HealthReport {
  status: HealthStatus
  live: boolean
  ready: boolean
  service: {
    name: string
    advertisableFQDN: string
    port: number
    network: OverlayNetwork
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

export type TopicAnchorHeaderResolver = (blockHeight: number) => Promise<
  | {
      blockHeight: number
      blockHash: string
      merkleRoot?: string
      /** Independent full block count bound to blockHash; never an overlay subset count. */
      blockTransactionCount?: number
    }
  | undefined
>

interface BASMCapableEngine extends Engine {
  provideTopicAnchorTip: (topic: string) => Promise<any>
  provideTopicAnchorRange: (topic: string, fromHeight: number, toHeight: number) => Promise<any>
  provideAdmittedList: (topic: string, blockHeight: number, blockHash?: string) => Promise<any>
  provideCompoundMerklePath: (topic: string, blockHeight: number, txids: string[]) => Promise<any>
  provideRawTransactions: (txids: string[], topic?: string) => Promise<any>
  startBASMSync: () => Promise<any>
  advanceTopicAnchorChains: (toHeight?: number) => Promise<void>
  evictUnprovenTransactions: (options?: {
    topic?: string
    thresholdBlocks?: number
  }) => Promise<any>
  refreshUnprovenTransactionProofs: (options: {
    topic?: string
    thresholdBlocks?: number
    proofProvider: (
      txid: string
    ) => Promise<{ merklePath: MerklePath; blockHeight?: number } | undefined>
  }) => Promise<any>
  maintainUnprovenTransactions: (options: {
    topic?: string
    thresholdBlocks?: number
    proofProvider: (
      txid: string
    ) => Promise<{ merklePath: MerklePath; blockHeight?: number } | undefined>
  }) => Promise<any>
  evictAppliedTransaction: (
    txid: string,
    options?: { topic?: string; reason?: string }
  ) => Promise<any>
  handleReorg: (input: ReorgHandlerInput) => Promise<any>
  revalidateRecentAnchors: (depth?: number) => Promise<any>
}

class PublicRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicRequestError'
  }
}

class UnsupportedBasmCapabilityError extends PublicRequestError {
  readonly code = 'BASM_UNSUPPORTED'

  constructor() {
    super('BASM capability is not supported by this Overlay engine')
    this.name = 'UnsupportedBasmCapabilityError'
  }
}

function publicErrorMessage(
  error: unknown,
  fallback: string = 'Request could not be processed'
): string {
  return error instanceof PublicRequestError ? error.message : fallback
}

function secretMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

function assertSharedSecret(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new TypeError(`${label} must not contain leading or trailing whitespace`)
  }
  const byteLength = new TextEncoder().encode(value).byteLength
  if (byteLength < MIN_SHARED_SECRET_BYTES || byteLength > MAX_SHARED_SECRET_BYTES) {
    throw new TypeError(
      `${label} must contain between ${MIN_SHARED_SECRET_BYTES} and ${MAX_SHARED_SECRET_BYTES} UTF-8 bytes`
    )
  }
  if (
    Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError(`${label} must not contain control characters`)
  }
}

function assertConfigurationObject(value: unknown, label: string): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertBooleanOption(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
}

function assertSingleLineString(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = true
): asserts value is string {
  assertBoundedString(value, label, maxBytes, allowEmpty)
  if (
    Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError(`${label} must not contain control characters`)
  }
}

function assertIntegerOption(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  allowUnlimited = false
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    ((value as number) < minimum && !(allowUnlimited && value === -1)) ||
    (value as number) > maximum
  ) {
    const unlimited = allowUnlimited ? ' or -1' : ''
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}${unlimited}`)
  }
}

function normalizeConfiguredOrigin(value: unknown): string {
  assertSingleLineString(value, 'Allowed origin', 2048, false)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Allowed origins must be valid HTTP(S) origins')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin === 'null'
  ) {
    throw new TypeError(
      'Allowed origins must not contain credentials, paths, queries, or fragments'
    )
  }
  return parsed.origin
}

function normalizeAdvertisableFQDN(value: unknown): string {
  assertSingleLineString(value, 'Advertisable FQDN', 2048, false)
  let parsed: URL
  try {
    parsed = new URL(value.includes('://') ? value : `https://${value}`)
  } catch {
    throw new TypeError('Advertisable FQDN must be a valid HTTPS host')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname === ''
  ) {
    throw new TypeError('Advertisable FQDN must be an HTTPS host without credentials or a path')
  }
  return parsed.host
}

function parseTopicsHeader(header: string): string[] {
  const value = header.trim()
  let parsed: unknown
  try {
    parsed = value.startsWith('[') ? JSON.parse(value) : value.split(',').map(topic => topic.trim())
  } catch {
    throw new PublicRequestError(
      'Invalid x-topics header: expected a comma-separated list or JSON string array'
    )
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some(topic => typeof topic !== 'string' || topic.length === 0)
  ) {
    throw new PublicRequestError(
      'Invalid x-topics header: expected a comma-separated list or JSON string array'
    )
  }
  return parsed
}

function assertRegistryName(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, 256, false)
  if (
    value === '__proto__' ||
    value === 'prototype' ||
    value === 'constructor' ||
    Array.from(value).some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    throw new TypeError(`${label} is invalid`)
  }
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

  // Network ('main', 'test', or TerraTestNet)
  network: OverlayNetwork = 'main'

  // If no custom ChainTracker is configured, default is a WhatsOnChain instance
  // (We keep a property for it, so we can pass it to Engine)
  chainTracker: ChainTracker | 'scripts only' = new WhatsOnChain('main')

  // The Overlay Engine
  engine?: Engine

  // Configured Topic Managers
  managers: Record<string, TopicManager> = Object.create(null) as Record<string, TopicManager>

  // Configured Lookup Services
  services: Record<string, LookupService> = Object.create(null) as Record<string, LookupService>

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
  reorgStreamAllowPrivateHosts: boolean = false

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
  arcadeAllowPrivateHosts: boolean = false

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
    batchSize?: number
    maxReportResults?: number
  } = {
    requestTimeoutMs: 10000, // 10 seconds
    hostDownRevokeScore: 3,
    autoBanOnRemoval: true,
    allowPrivateHosts: false,
    batchSize: undefined,
    maxReportResults: undefined
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
    includeDetails: false,
    timeoutMs: 5000
  }

  // Extra application-specific health checks
  healthChecks: HealthCheckDefinition[] = []

  // Lifecycle marker for readiness/liveness reporting
  isListening: boolean = false

  // Active HTTP server, retained so timeout policy is observable and the
  // process can add graceful-close handling without replacing app.listen().
  server?: Server
  private closePromise?: Promise<void>

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
      contentSecurityPolicy:
        "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' https://cdn.jsdelivr.net; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
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
  constructor(
    public name: string,
    public privateKey: string,
    public advertisableFQDN: string,
    adminToken?: string
  ) {
    if (adminToken !== undefined) assertSharedSecret(adminToken, 'The administrative Bearer token')
    this.advertisableFQDN = normalizeAdvertisableFQDN(advertisableFQDN)
    this.app = express()
    this.logger.log(chalk.green.bold(`${name} constructed`))
    this.adminToken = adminToken ?? uuidv4() // generate random if not provided
  }

  /**
   * Returns the current admin token in case you need to programmatically retrieve or display it.
   */
  getAdminToken(): string {
    return this.adminToken
  }

  /**
   * Configures the port on which the server will listen.
   * @param port - The port number
   */
  configurePort(port: number): void {
    assertIntegerOption(port, 'Server port', 1, 65_535)
    this.port = port
    this.logger.log(chalk.blue(`Server port set to ${port}`))
  }

  /**
   * Configures the web user interface
   * @param config - Web UI configuration options
   */
  configureWebUI(config: UIConfig): void {
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
   *   - batchSize: Mongo scan batch size; -1 uses the driver default
   *   - maxReportResults: Maximum retained result details; -1 retains all
   */
  configureJanitor(config: Partial<typeof this.janitorConfig>): void {
    assertConfigurationObject(config, 'Janitor configuration')
    const next = { ...this.janitorConfig }
    if (config.requestTimeoutMs !== undefined) {
      assertIntegerOption(config.requestTimeoutMs, 'Janitor requestTimeoutMs', 1, 300_000)
      next.requestTimeoutMs = config.requestTimeoutMs
    }
    if (config.hostDownRevokeScore !== undefined) {
      assertIntegerOption(config.hostDownRevokeScore, 'Janitor hostDownRevokeScore', 1, 1000)
      next.hostDownRevokeScore = config.hostDownRevokeScore
    }
    if (config.autoBanOnRemoval !== undefined) {
      assertBooleanOption(config.autoBanOnRemoval, 'Janitor autoBanOnRemoval')
      next.autoBanOnRemoval = config.autoBanOnRemoval
    }
    if (config.allowPrivateHosts !== undefined) {
      assertBooleanOption(config.allowPrivateHosts, 'Janitor allowPrivateHosts')
      next.allowPrivateHosts = config.allowPrivateHosts
    }
    if (config.batchSize !== undefined) {
      assertIntegerOption(config.batchSize, 'Janitor batchSize', 1, 100_000, true)
      next.batchSize = config.batchSize
    }
    if (config.maxReportResults !== undefined) {
      assertIntegerOption(config.maxReportResults, 'Janitor maxReportResults', 1, 1_000_000, true)
      next.maxReportResults = config.maxReportResults
    }
    this.janitorConfig = next
    this.logger.log(chalk.blue('Janitor service has been configured.'))
  }

  /**
   * Configures health-report behavior.
   */
  configureHealth(config: Partial<HealthConfig>): void {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new TypeError('Health configuration must be an object')
    }
    const next = { ...this.healthConfig }
    if (Object.prototype.hasOwnProperty.call(config, 'includeDetails')) {
      if (typeof config.includeDetails !== 'boolean') {
        throw new TypeError('Health includeDetails must be a boolean')
      }
      next.includeDetails = config.includeDetails
    }
    if (Object.prototype.hasOwnProperty.call(config, 'timeoutMs')) {
      if (
        !Number.isSafeInteger(config.timeoutMs) ||
        (config.timeoutMs as number) < 1 ||
        (config.timeoutMs as number) > MAX_HEALTH_TIMEOUT_MS
      ) {
        throw new TypeError(
          `Health timeoutMs must be an integer from 1 to ${MAX_HEALTH_TIMEOUT_MS}`
        )
      }
      next.timeoutMs = config.timeoutMs as number
    }
    if (Object.prototype.hasOwnProperty.call(config, 'contextProvider')) {
      if (config.contextProvider !== undefined && typeof config.contextProvider !== 'function') {
        throw new TypeError('Health contextProvider must be a function')
      }
      next.contextProvider = config.contextProvider
    }
    this.healthConfig = next
    this.logger.log(chalk.blue('Health reporting has been configured.'))
  }

  /**
   * Configures explicit browser origins and bounded request/resource policy.
   * Public cross-origin access is the default; pass allowedOrigins or set
   * OVERLAY_CORS_MODE=allowlist to restrict browser callers.
   */
  configureEdgePolicy(
    config: Partial<Omit<EdgePolicyConfig, 'http' | 'securityHeaders'>> & {
      http?: Partial<HttpServerPolicyDefaults>
      securityHeaders?: SecurityHeadersOptions
    }
  ): void {
    assertConfigurationObject(config, 'HTTP edge policy')
    const next: EdgePolicyConfig = {
      ...this.edgePolicyConfig,
      allowedOrigins:
        this.edgePolicyConfig.allowedOrigins === undefined
          ? undefined
          : [...this.edgePolicyConfig.allowedOrigins],
      http: { ...this.edgePolicyConfig.http },
      securityHeaders: { ...this.edgePolicyConfig.securityHeaders }
    }
    if (config.environmentPrefix !== undefined) {
      if (
        typeof config.environmentPrefix !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(config.environmentPrefix)
      ) {
        throw new TypeError('HTTP edge environmentPrefix is invalid')
      }
      next.environmentPrefix = config.environmentPrefix
    }
    if (config.allowedOrigins !== undefined) {
      if (
        !Array.isArray(config.allowedOrigins) ||
        config.allowedOrigins.length > MAX_CONFIGURED_ORIGINS
      ) {
        throw new TypeError(`allowedOrigins must contain at most ${MAX_CONFIGURED_ORIGINS} origins`)
      }
      next.allowedOrigins = [...new Set(config.allowedOrigins.map(normalizeConfiguredOrigin))]
    }
    if (config.jsonBodyLimitBytes !== undefined) {
      assertIntegerOption(
        config.jsonBodyLimitBytes,
        'JSON body limit',
        1,
        MAX_CONFIGURED_BODY_BYTES,
        true
      )
      next.jsonBodyLimitBytes = config.jsonBodyLimitBytes
    }
    if (config.binaryBodyLimitBytes !== undefined) {
      assertIntegerOption(
        config.binaryBodyLimitBytes,
        'Binary body limit',
        1,
        MAX_CONFIGURED_BODY_BYTES,
        true
      )
      next.binaryBodyLimitBytes = config.binaryBodyLimitBytes
    }
    if (config.maxConcurrentRequests !== undefined) {
      assertIntegerOption(
        config.maxConcurrentRequests,
        'Maximum concurrent requests',
        1,
        100_000,
        true
      )
      next.maxConcurrentRequests = config.maxConcurrentRequests
    }

    if (config.http !== undefined) {
      assertConfigurationObject(config.http, 'HTTP server policy')
      const httpBounds: Array<[keyof HttpServerPolicyDefaults, number, boolean]> = [
        ['requestTimeoutMs', 3_600_000, false],
        ['headersTimeoutMs', 3_600_000, false],
        ['keepAliveTimeoutMs', 3_600_000, false],
        ['socketTimeoutMs', 3_600_000, false],
        ['maxRequestsPerSocket', 1_000_000, false],
        ['maxConnections', 1_000_000, true]
      ]
      for (const [key, maximum, allowUnlimited] of httpBounds) {
        const value = config.http[key]
        if (value === undefined) continue
        assertIntegerOption(value, `HTTP ${key}`, 1, maximum, allowUnlimited)
        next.http[key] = value
      }
      if (next.http.headersTimeoutMs > next.http.requestTimeoutMs) {
        throw new TypeError('HTTP headersTimeoutMs cannot exceed requestTimeoutMs')
      }
      if (next.http.keepAliveTimeoutMs > next.http.requestTimeoutMs) {
        throw new TypeError('HTTP keepAliveTimeoutMs cannot exceed requestTimeoutMs')
      }
    }

    if (config.securityHeaders !== undefined) {
      assertConfigurationObject(config.securityHeaders, 'Security headers policy')
      const headers = config.securityHeaders
      if (Object.prototype.hasOwnProperty.call(headers, 'environmentPrefix')) {
        throw new TypeError('Security headers must use the top-level environmentPrefix')
      }
      for (const key of ['contentSecurityPolicy', 'permissionsPolicy'] as const) {
        const value = headers[key]
        if (value === undefined) continue
        if (value !== false) assertSingleLineString(value, `Security header ${key}`, 16 * 1024)
        next.securityHeaders[key] = value
      }
      const enumeratedHeaders = {
        crossOriginResourcePolicy: ['same-origin', 'same-site', 'cross-origin'],
        crossOriginOpenerPolicy: ['same-origin', 'same-origin-allow-popups', 'unsafe-none'],
        frameOptions: ['DENY', 'SAMEORIGIN']
      } as const
      for (const key of Object.keys(enumeratedHeaders) as Array<keyof typeof enumeratedHeaders>) {
        const value = headers[key]
        if (value === undefined) continue
        if (value !== false && !(enumeratedHeaders[key] as readonly unknown[]).includes(value)) {
          throw new TypeError(`Security header ${key} is invalid`)
        }
        ;(next.securityHeaders as Record<string, unknown>)[key] = value
      }
      if (headers.strictTransportSecurity !== undefined) {
        assertBooleanOption(headers.strictTransportSecurity, 'Strict-Transport-Security setting')
        next.securityHeaders.strictTransportSecurity = headers.strictTransportSecurity
      }
    }
    this.edgePolicyConfig = next
    this.logger.log(chalk.blue('HTTP edge policy has been configured.'))
  }

  /**
   * Registers an application-specific health check.
   */
  registerHealthCheck(definition: HealthCheckDefinition): void {
    if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
      throw new TypeError('Health check definition must be an object')
    }
    if (
      typeof definition.name !== 'string' ||
      definition.name.length === 0 ||
      new TextEncoder().encode(definition.name).byteLength > MAX_HEALTH_NAME_BYTES ||
      Array.from(definition.name).some(character => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 0x1f || codePoint === 0x7f
      })
    ) {
      throw new TypeError('Health check name is invalid')
    }
    if (['process', 'engine', 'knex', 'mongo'].includes(definition.name)) {
      throw new TypeError('Health check name is reserved')
    }
    if (
      definition.scope !== undefined &&
      definition.scope !== 'live' &&
      definition.scope !== 'ready'
    ) {
      throw new TypeError('Health check scope is invalid')
    }
    if (definition.critical !== undefined && typeof definition.critical !== 'boolean') {
      throw new TypeError('Health check critical must be a boolean')
    }
    if (typeof definition.handler !== 'function') {
      throw new TypeError('Health check handler must be a function')
    }
    if (
      !this.healthChecks.some(check => check.name === definition.name) &&
      this.healthChecks.length >= MAX_HEALTH_CHECKS
    ) {
      throw new RangeError(`Cannot register more than ${MAX_HEALTH_CHECKS} health checks`)
    }
    this.healthChecks = this.healthChecks.filter(check => check.name !== definition.name)
    this.healthChecks.push({
      name: definition.name,
      scope: definition.scope ?? 'ready',
      critical: definition.critical ?? false,
      handler: definition.handler
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
  configureAdminIdentityKey(identityKey: string): void {
    if (typeof identityKey !== 'string' || !/^(?:02|03)[0-9a-fA-F]{64}$/.test(identityKey)) {
      throw new TypeError('Admin identity key must be a compressed secp256k1 public key')
    }
    this.adminIdentityKey = identityKey
    this.logger.log(chalk.blue('Admin identity key has been configured.'))
  }

  /**
   * Configures BRC-103 session storage for the administrative mutual-auth
   * middleware. Horizontally scaled services should supply a shared
   * AsyncSessionManager rather than use the default process-local store.
   */
  configureAuthSessionManager(sessionManager: SessionManager | AsyncSessionManager): void {
    this.authSessionManager = sessionManager
    this.logger.log(chalk.blue('BSV authentication session manager has been configured.'))
  }

  /**
   * Configures the logger to be used by the server.
   * @param logger - A logger object (e.g., console)
   */
  configureLogger(logger: typeof console): void {
    if (typeof logger !== 'object' || logger === null || typeof logger.log !== 'function') {
      throw new TypeError('Logger must provide a log function')
    }
    this.logger = logger
    this.logger.log(chalk.blue('Logger has been configured.'))
  }

  /**
   * Configures the BSV Blockchain network to be used.
   * Mainnet/testnet use WhatsOnChain by default. TTN requires an explicit
   * ChainTracks provider because WhatsOnChain does not serve TerraTestNet.
   * @param network - The network ('main', 'test', or 'ttn')
   */
  configureNetwork(network: OverlayNetwork): void {
    if (network !== 'main' && network !== 'test' && network !== 'ttn') {
      throw new TypeError('Network must be main, test, or ttn')
    }
    this.network = network
    this.chainTracker =
      network === 'ttn'
        ? {
            isValidRootForHeight: async () => {
              throw new Error('TTN requires configureChaintracks() or configureChainTracker()')
            },
            currentHeight: async () => {
              throw new Error('TTN requires configureChaintracks() or configureChainTracker()')
            }
          }
        : new WhatsOnChain(network)
    this.logger.log(chalk.blue(`Network set to ${network}`))
  }

  /**
   * Configures the ChainTracker to be used.
   * If 'scripts only' is used, it implies no full SPV chain tracking in the Engine.
   * @param chainTracker - An instance of ChainTracker or 'scripts only'
   */
  configureChainTracker(chainTracker?: ChainTracker | 'scripts only'): void {
    if (chainTracker === undefined) {
      if (this.network === 'ttn') {
        throw new Error('TTN requires an explicit ChainTracker')
      }
      chainTracker = new WhatsOnChain(this.network)
    }
    if (
      chainTracker !== 'scripts only' &&
      (typeof chainTracker !== 'object' ||
        chainTracker === null ||
        typeof chainTracker.isValidRootForHeight !== 'function' ||
        typeof chainTracker.currentHeight !== 'function')
    ) {
      throw new TypeError('ChainTracker must implement root validation and currentHeight')
    }
    this.chainTracker = chainTracker
    this.logger.log(chalk.blue('ChainTracker has been configured.'))
  }

  /**
   * Configures the ARC API key.
   * @param apiKey - The ARC API key
   */
  configureArcApiKey(apiKey: string): void {
    assertSingleLineString(apiKey, 'ARC API key', MAX_SHARED_SECRET_BYTES)
    this.arcApiKey = apiKey
    this.logger.log(chalk.blue('ARC API key has been configured.'))
  }

  /**
   * Configures the ARC callback token expected by /arc-ingest.
   * @param token - The token ARC should present when posting callback notifications.
   */
  configureArcCallbackToken(token: string): void {
    assertSharedSecret(token, 'The ARC callback token')
    this.arcCallbackToken = token
    this.logger.log(chalk.blue('ARC callback token has been configured.'))
  }

  /**
   * Configures Arcade for first-choice transaction propagation and proof lookup.
   */
  configureArcade(
    url: string,
    config: {
      apiKey?: string
      deploymentId?: string
      chaintracksApiPrefix?: string
      allowPrivateHosts?: boolean
    } = {}
  ): void {
    assertConfigurationObject(config, 'Arcade configuration')
    if (config.allowPrivateHosts !== undefined) {
      assertBooleanOption(config.allowPrivateHosts, 'Arcade allowPrivateHosts')
    }
    const allowPrivateHosts = config.allowPrivateHosts ?? false
    secureServiceFetch(url, undefined, allowPrivateHosts)
    if (config.apiKey !== undefined) {
      assertSingleLineString(config.apiKey, 'Arcade API key', MAX_SHARED_SECRET_BYTES)
    }
    if (config.deploymentId !== undefined) {
      assertSingleLineString(config.deploymentId, 'Arcade deployment ID', 1024)
    }
    if (config.chaintracksApiPrefix !== undefined) {
      assertSingleLineString(config.chaintracksApiPrefix, 'Arcade Chaintracks API prefix', 2048)
      // Reuse the provider's URL-path parser even when Chaintracks is configured later.
      const chaintracksStreamUrl = new ChaintracksProvider(url, {
        apiPrefix: config.chaintracksApiPrefix,
        allowPrivateHosts
      }).reorgStreamUrl()
      if (!chaintracksStreamUrl.endsWith('/reorg/stream')) {
        throw new TypeError('Chaintracks API prefix must be a URL path')
      }
    }
    this.arcadeUrl = url
    this.arcadeApiKey = config.apiKey
    this.arcadeDeploymentId = config.deploymentId
    this.arcadeAllowPrivateHosts = allowPrivateHosts
    if (config.chaintracksApiPrefix !== undefined) {
      this.arcadeChaintracksApiPrefix = config.chaintracksApiPrefix
    }
    this.logger.log(chalk.blue('Arcade provider has been configured.'))
  }

  /**
   * Configures a go-chaintracks compatible service for header validation and
   * BASM reorg streaming. Arcade exposes this at `/chaintracks/v2`.
   */
  configureChaintracks(
    url: string,
    config: {
      apiPrefix?: string
      reorgStream?: boolean
      scanDepth?: number
      allowPrivateHosts?: boolean
    } = {}
  ): void {
    assertConfigurationObject(config, 'Chaintracks configuration')
    if (config.reorgStream !== undefined) {
      assertBooleanOption(config.reorgStream, 'Chaintracks reorgStream')
    }
    if (config.allowPrivateHosts !== undefined) {
      assertBooleanOption(config.allowPrivateHosts, 'Chaintracks allowPrivateHosts')
    }
    if (config.scanDepth !== undefined) {
      assertIntegerOption(config.scanDepth, 'Chaintracks scanDepth', 1, 100_000)
    }
    const apiPrefix = config.apiPrefix ?? '/chaintracks/v2'
    const client = new ChaintracksProvider(url, {
      apiPrefix,
      allowPrivateHosts: config.allowPrivateHosts
    })
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
      this.configureReorgStream(client.reorgStreamUrl(), config.scanDepth, config.allowPrivateHosts)
    }
    this.logger.log(chalk.blue('go-chaintracks provider has been configured.'))
  }

  /**
   * Enables or disables GASP synchronization (high-level setting).
   * This is a broad toggle that can be overridden or customized through syncConfiguration.
   * @param enable - true to enable, false to disable
   */
  configureEnableGASPSync(enable: boolean): void {
    assertBooleanOption(enable, 'GASP synchronization setting')
    this.enableGASPSync = enable
    this.logger.log(chalk.blue(`GASP synchronization ${enable ? 'enabled' : 'disabled'}.`))
  }

  /**
   * Enables or disables BRC-136 BASM synchronization.
   * BASM is opt-in because it requires direct proofs and block hash resolution.
   */
  configureEnableBASMSync(enable: boolean): void {
    assertBooleanOption(enable, 'BASM synchronization setting')
    this.enableBASMSync = enable
    this.logger.log(chalk.blue(`BASM synchronization ${enable ? 'enabled' : 'disabled'}.`))
  }

  /**
   * Configures the block header resolver used to derive BASM block hashes.
   */
  configureTopicAnchorHeaderResolver(resolver: TopicAnchorHeaderResolver): void {
    if (typeof resolver !== 'function') {
      throw new TypeError('Topic anchor header resolver must be a function')
    }
    this.topicAnchorHeaderResolver = resolver
    this.logger.log(chalk.blue('BASM topic anchor header resolver has been configured.'))
  }

  /**
   * Configures the go-chaintracks (Arcade) reorg SSE stream used to reconcile
   * BASM anchors with blockchain reorganizations in real time.
   * @param url - The reorg stream URL, e.g. `https://arcade.example/v2/reorg/stream`.
   * @param scanDepth - Optional revalidation-sweep depth in blocks (default 3).
   */
  configureReorgStream(url: string, scanDepth?: number, allowPrivateHosts = false): void {
    assertBooleanOption(allowPrivateHosts, 'Reorg stream allowPrivateHosts')
    if (scanDepth !== undefined) {
      assertIntegerOption(scanDepth, 'Reorg scanDepth', 1, 100_000)
      this.reorgScanDepth = scanDepth
    }
    this.reorgStreamUrl = secureServiceFetch(url, undefined, allowPrivateHosts).baseUrl
    this.reorgStreamAllowPrivateHosts = allowPrivateHosts
    this.logger.log(chalk.blue('BASM reorg stream has been configured.'))
  }

  /**
   * Configures the opt-in unproven state eviction threshold.
   */
  configureUnprovenEviction(config: { thresholdBlocks?: number }): void {
    if (config.thresholdBlocks !== undefined) {
      if (
        !Number.isSafeInteger(config.thresholdBlocks) ||
        config.thresholdBlocks < 1 ||
        config.thresholdBlocks > 10_000_000
      ) {
        throw new TypeError('thresholdBlocks must be an integer between 1 and 10000000')
      }
      this.unprovenEvictionBlocks = config.thresholdBlocks
    }
    this.logger.log(chalk.blue('Unproven transaction eviction has been configured.'))
  }

  /**
   * Configures periodic unproven maintenance. Each run first tries configured
   * proof providers, then evicts rows that are still unproven past the threshold.
   */
  configureUnprovenMaintenance(config: { intervalMs?: number; thresholdBlocks?: number }): void {
    if (config.intervalMs !== undefined) {
      if (
        !Number.isSafeInteger(config.intervalMs) ||
        config.intervalMs < 0 ||
        config.intervalMs > 0x7fffffff
      ) {
        throw new TypeError('intervalMs must be an integer between 0 and 2147483647')
      }
      this.unprovenMaintenanceIntervalMs = config.intervalMs
    }
    if (config.thresholdBlocks !== undefined) {
      this.configureUnprovenEviction({ thresholdBlocks: config.thresholdBlocks })
    }
    this.logger.log(chalk.blue('Unproven transaction maintenance has been configured.'))
  }

  /**
   * Configures how often the BASM anchor chain is extended with empty anchors to
   * follow the chain tip. Set to 0 to disable periodic polling.
   */
  configureBASMBlockPollInterval(intervalMs: number): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 0x7fffffff) {
      throw new TypeError('intervalMs must be an integer between 0 and 2147483647')
    }
    this.basmBlockPollIntervalMs = intervalMs
    this.logger.log(chalk.blue(`BASM block poll interval set to ${intervalMs}ms.`))
  }

  /**
   * Enables or disables verbose request logging.
   * @param enable - true to enable, false to disable
   */
  configureVerboseRequestLogging(enable: boolean): void {
    assertBooleanOption(enable, 'Verbose request logging setting')
    this.verboseRequestLogging = enable
    this.logger.log(chalk.blue(`Verbose request logging ${enable ? 'enabled' : 'disabled'}.`))
  }

  /**
   * Configure Knex (SQL) database connection.
   * @param config - Knex configuration object, or a MySQL connection string loaded from configuration.
   */
  async configureKnex(config: Knex.Knex.Config | string): Promise<void> {
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
  async configureMongo(connectionString: string): Promise<void> {
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
  configureTopicManager(name: string, manager: TopicManager): void {
    assertRegistryName(name, 'Topic manager name')
    this.managers[name] = manager
    this.logger.log(chalk.blue(`Configured topic manager ${name}`))
  }

  /**
   * Configures a Lookup Service.
   * @param name - The name of the Lookup Service
   * @param service - An instance of LookupService
   */
  configureLookupService(name: string, service: LookupService): void {
    assertRegistryName(name, 'Lookup service name')
    this.services[name] = service
    this.logger.log(chalk.blue(`Configured lookup service ${name}`))
  }

  /**
   * Configures a Lookup Service using Knex (SQL) database.
   * @param name - The name of the Lookup Service
   * @param serviceFactory - A factory function that creates a LookupService instance using Knex
   */
  configureLookupServiceWithKnex(
    name: string,
    serviceFactory: (knex: Knex.Knex) => { service: LookupService; migrations: Migration[] }
  ): void {
    assertRegistryName(name, 'Lookup service name')
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
  configureLookupServiceWithMongo(
    name: string,
    serviceFactory: (mongoDb: Db) => LookupService
  ): void {
    assertRegistryName(name, 'Lookup service name')
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
  configureEngineParams(params: EngineConfig): void {
    assertConfigurationObject(params, 'Engine configuration')
    for (const key of [
      'logTime',
      'throwOnBroadcastFailure',
      'suppressDefaultSyncAdvertisements',
      'enableBASMSync',
      'reorgStreamAllowPrivateHosts'
    ] as const) {
      const value = params[key]
      if (value !== undefined) assertBooleanOption(value, `Engine ${key}`)
    }
    if (params.logPrefix !== undefined) {
      assertSingleLineString(params.logPrefix, 'Engine logPrefix', 1024)
    }
    if (
      params.topicAnchorHeaderResolver !== undefined &&
      typeof params.topicAnchorHeaderResolver !== 'function'
    ) {
      throw new TypeError('Engine topicAnchorHeaderResolver must be a function')
    }
    if (params.chainTracker !== undefined && params.chainTracker !== 'scripts only') {
      if (
        typeof params.chainTracker !== 'object' ||
        params.chainTracker === null ||
        typeof params.chainTracker.isValidRootForHeight !== 'function' ||
        typeof params.chainTracker.currentHeight !== 'function'
      ) {
        throw new TypeError('Engine chainTracker must implement root validation and currentHeight')
      }
    }
    if (params.reorgScanDepth !== undefined) {
      assertIntegerOption(params.reorgScanDepth, 'Engine reorgScanDepth', 1, 100_000)
    }
    if (params.unprovenMaintenanceIntervalMs !== undefined) {
      assertIntegerOption(
        params.unprovenMaintenanceIntervalMs,
        'Engine unprovenMaintenanceIntervalMs',
        0,
        0x7fffffff
      )
    }
    if (params.unprovenEvictionBlocks !== undefined) {
      assertIntegerOption(
        params.unprovenEvictionBlocks,
        'Engine unprovenEvictionBlocks',
        1,
        10_000_000
      )
    }
    if (params.maxLookupResults !== undefined) {
      assertIntegerOption(
        params.maxLookupResults,
        'Engine maxLookupResults',
        1,
        Number.MAX_SAFE_INTEGER,
        true
      )
    }
    if (params.reorgStreamUrl !== undefined) {
      assertSingleLineString(params.reorgStreamUrl, 'Engine reorgStreamUrl', 2048, false)
      secureServiceFetch(
        params.reorgStreamUrl,
        undefined,
        params.reorgStreamAllowPrivateHosts ?? false
      )
    }
    for (const key of ['shipTrackers', 'slapTrackers'] as const) {
      const trackers = params[key]
      if (trackers !== undefined && !Array.isArray(trackers)) {
        throw new TypeError(`Engine ${key} must be an array`)
      }
    }
    this.engineConfig = {
      ...this.engineConfig,
      ...params,
      shipTrackers:
        params.shipTrackers === undefined
          ? this.engineConfig.shipTrackers
          : [...params.shipTrackers],
      slapTrackers:
        params.slapTrackers === undefined
          ? this.engineConfig.slapTrackers
          : [...params.slapTrackers]
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
  async configureEngine(autoConfigureShipSlap = true): Promise<void> {
    const knex = this.ensureKnex()
    const maxLookupResults =
      this.engineConfig.maxLookupResults ??
      readResourceLimit(
        this.edgePolicyConfig.environmentPrefix,
        'MAX_LOOKUP_RESULTS',
        profileValue(readResourceProfile(this.edgePolicyConfig.environmentPrefix), {
          small: 500,
          standard: 1000,
          highThroughput: 5000
        }),
        1_000_000
      )

    if (autoConfigureShipSlap) {
      const mongoDb = this.ensureMongo()
      const shipStorage = new SHIPStorage(mongoDb)
      const slapStorage = new SLAPStorage(mongoDb)

      // Run the one-time discovery migration before the engine can accept
      // traffic, so a failed unique-index build is a visible startup failure.
      await shipStorage.ensureIndexes()
      await slapStorage.ensureIndexes()

      this.configureTopicManager('tm_ship', new SHIPTopicManager())
      this.configureTopicManager('tm_slap', new SLAPTopicManager())

      const shipStorageForLookup =
        this.banService === undefined
          ? shipStorage
          : new BanAwareSHIPStorage(shipStorage, this.banService, this.logger)
      const slapStorageForLookup =
        this.banService === undefined
          ? slapStorage
          : new BanAwareSLAPStorage(slapStorage, this.banService, this.logger)

      this.services.ls_ship = new ResourceBoundedLookupWrapper(
        new SHIPLookupService(shipStorageForLookup as any),
        maxLookupResults
      )
      this.services.ls_slap = new ResourceBoundedLookupWrapper(
        new SLAPLookupService(slapStorageForLookup as any),
        maxLookupResults
      )
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
      this.engineConfig.shipTrackers ?? this.defaultDiscoveryTrackers(),
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
      this.engineConfig.unprovenEvictionBlocks ?? this.unprovenEvictionBlocks,
      maxLookupResults
    )

    this.initServerWallet()
    this.logger.log(chalk.green('Engine has been configured.'))
  }

  /** Wrap SHIP/SLAP managers and services with ban-aware filters if BanService is configured. */
  private wrapBanAwareServices(): void {
    if (this.banService === undefined) return
    for (const key of ['tm_ship', 'tm_slap'] as const) {
      if (this.managers[key] !== undefined) {
        const label = key === 'tm_ship' ? 'SHIP' : 'SLAP'
        this.managers[key] = new BanAwareTopicManager(
          this.managers[key],
          this.banService,
          label,
          this.logger
        )
        this.logger.log(chalk.blue(`${label} topic manager wrapped with ban-aware filter.`))
      }
    }
    for (const key of ['ls_ship', 'ls_slap'] as const) {
      if (this.services[key] !== undefined) {
        const label = key === 'ls_ship' ? 'SHIP' : 'SLAP'
        this.services[key] = new BanAwareLookupWrapper(
          this.services[key],
          this.banService,
          label,
          this.logger
        )
        this.logger.log(chalk.blue(`${label} lookup service wrapped with ban-aware filter.`))
      }
    }
  }

  /** Build the sync config based on enableGASPSync and engineConfig. */
  private buildSyncConfig(): SyncConfigurationMap {
    if (this.enableGASPSync) {
      return this.engineConfig.syncConfiguration ?? {}
    }
    const syncConfig: SyncConfigurationMap = Object.create(null) as SyncConfigurationMap
    for (const name of Object.keys(this.managers)) {
      syncConfig[name] = false
    }
    return syncConfig
  }

  /** Build the configured transaction propagation provider chain. */
  private buildBroadcaster(): Broadcaster | undefined {
    const providers: NamedBroadcaster[] = []
    const callbackUrl = `https://${this.advertisableFQDN}/arc-ingest`

    if (typeof this.arcadeUrl === 'string' && this.arcadeUrl.length > 0) {
      this.arcadeProvider = new ArcadeProvider(this.arcadeUrl, {
        apiKey: this.arcadeApiKey,
        callbackUrl,
        callbackToken: this.arcCallbackToken,
        deploymentId: this.arcadeDeploymentId,
        allowPrivateHosts: this.arcadeAllowPrivateHosts
      })
      providers.push({
        name: 'Arcade',
        broadcaster: this.arcadeProvider
      })
    } else {
      this.arcadeProvider = undefined
    }

    if (this.network !== 'ttn' && typeof this.arcApiKey === 'string' && this.arcApiKey.length > 0) {
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

  private ensureArcadeProvider(): ArcadeProvider | undefined {
    if (this.arcadeProvider !== undefined) return this.arcadeProvider
    if (typeof this.arcadeUrl !== 'string' || this.arcadeUrl.length === 0) return undefined
    this.arcadeProvider = new ArcadeProvider(this.arcadeUrl, {
      apiKey: this.arcadeApiKey,
      callbackUrl: `https://${this.advertisableFQDN}/arc-ingest`,
      callbackToken: this.arcCallbackToken,
      deploymentId: this.arcadeDeploymentId,
      allowPrivateHosts: this.arcadeAllowPrivateHosts
    })
    return this.arcadeProvider
  }

  private async fetchArcadeProof(txid: string): Promise<ArcadeMerkleProof | undefined> {
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
    if (valid !== true) {
      throw new Error(
        `Arcade proof for ${txid} did not match the chain tracker at height ${blockHeight}`
      )
    }
    return {
      ...proof,
      blockHeight
    }
  }

  private async fetchConfiguredMerkleProof(
    txid: string
  ): Promise<{ merklePath: MerklePath; blockHeight?: number } | undefined> {
    const proof = await this.fetchArcadeProof(txid)
    if (proof === undefined) return undefined
    return {
      merklePath: proof.merklePath,
      blockHeight: proof.blockHeight
    }
  }

  /** Build the BASM block header resolver. */
  private buildTopicAnchorHeaderResolver(): TopicAnchorHeaderResolver | undefined {
    const configured = this.engineConfig.topicAnchorHeaderResolver ?? this.topicAnchorHeaderResolver
    if (configured !== undefined) {
      return configured
    }

    if (this.network === 'ttn') return undefined

    return async (blockHeight: number) => {
      assertNonnegativeSafeInteger(blockHeight, 'WhatsOnChain block height')
      const response = await fetchWithDeadline(
        fetch,
        `https://api.whatsonchain.com/v1/bsv/${this.network}/block/${blockHeight}/header`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' }
        },
        BLOCK_HEADER_REQUEST_TIMEOUT_MS
      )
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(
          `WhatsOnChain header lookup failed for height ${blockHeight}: ${response.status}`
        )
      }
      const header = await readBoundedJson(
        response,
        MAX_BLOCK_HEADER_RESPONSE_BYTES,
        'WhatsOnChain header response',
        BLOCK_HEADER_REQUEST_TIMEOUT_MS
      )
      if (!isRecord(header)) throw new TypeError('WhatsOnChain returned an invalid block header')
      assertHash(header.hash, 'WhatsOnChain block hash')
      assertHash(header.merkleroot, 'WhatsOnChain Merkle root')
      return {
        blockHeight,
        blockHash: header.hash,
        merkleRoot: header.merkleroot
      }
    }
  }

  /** Resolve the SLAP trackers from config or network defaults. */
  private resolveSlapTrackers(): string[] | undefined {
    if (Array.isArray(this.engineConfig.slapTrackers)) return this.engineConfig.slapTrackers
    return this.defaultDiscoveryTrackers()
  }

  private defaultDiscoveryTrackers(): string[] {
    if (this.network === 'test') return DEFAULT_TESTNET_SLAP_TRACKERS
    if (this.network === 'ttn') return DEFAULT_TTN_SLAP_TRACKERS
    return DEFAULT_SLAP_TRACKERS
  }

  /** Build the WalletAdvertiser (or use user-provided one). */
  private async buildAdvertiser(): Promise<Advertiser | undefined> {
    if (this.engineConfig.advertiser !== undefined) return this.engineConfig.advertiser
    const storageBase =
      this.network !== 'main'
        ? 'https://staging-storage.babbage.systems'
        : 'https://storage.babbage.systems'
    try {
      return new WalletAdvertiser(
        this.network,
        this.privateKey,
        storageBase,
        `https://${this.advertisableFQDN}`
      )
    } catch (e) {
      this.logger.log(
        `Advertiser not initialized for FQDN ${this.advertisableFQDN} - SHIP and SLAP will be disabled. Reason: ${e}`
      )
      return undefined
    }
  }

  /** Initialize the server wallet for BSV mutual authentication. */
  private initServerWallet(): void {
    try {
      const keyDeriver = new KeyDeriver(new PrivateKey(this.privateKey, 'hex'))
      const storageManager = new WalletStorageManager(keyDeriver.identityKey)
      const signer = new WalletSigner(this.network, keyDeriver, storageManager)
      const services = new Services(this.network)
      this.serverWallet = new Wallet(signer, services)
      this.adminIdentityKey ??= keyDeriver.identityKey
      this.logger.log(chalk.blue('Server wallet initialized for BSV mutual authentication.'))
    } catch (e) {
      this.logger.log(
        chalk.yellow(
          `Server wallet could not be initialized. BSV auth will not be available. Reason: ${e}`
        )
      )
    }
  }

  /**
   * Ensures that Knex is configured and returns it.
   * @throws Error if Knex is not configured
   */
  private ensureKnex(): Knex.Knex {
    if (this.knex === undefined) {
      throw new TypeError(
        'You must configure your SQL database with the .configureKnex() method first!'
      )
    }
    return this.knex
  }

  /**
   * Ensures that MongoDB is configured and returns it.
   * @throws Error if MongoDB is not configured
   */
  private ensureMongo(): Db {
    if (this.mongoDb === undefined) {
      throw new TypeError(
        'You must configure your MongoDB connection with the .configureMongo() method first!'
      )
    }
    return this.mongoDb
  }

  /**
   * Ensures that the Overlay Engine is configured and returns it.
   * @throws Error if the Engine is not configured
   */
  private ensureEngine(): Engine {
    if (this.engine === undefined) {
      throw new TypeError(
        'You must configure your Overlay Services engine with the .configureEngine() method first!'
      )
    }
    return this.engine
  }

  /**
   * Creates a JanitorService instance with current configuration.
   */
  private createJanitor(): JanitorService {
    const mongoDb = this.ensureMongo()
    const prefix = this.edgePolicyConfig.environmentPrefix
    const profile = readResourceProfile(prefix)
    return new JanitorService({
      mongoDb,
      logger: this.logger,
      requestTimeoutMs: this.janitorConfig.requestTimeoutMs,
      hostDownRevokeScore: this.janitorConfig.hostDownRevokeScore,
      banService: this.banService,
      autoBanOnRemoval: this.janitorConfig.autoBanOnRemoval,
      allowPrivateHosts: this.janitorConfig.allowPrivateHosts,
      batchSize:
        this.janitorConfig.batchSize ??
        readResourceLimit(
          prefix,
          'JANITOR_BATCH_SIZE',
          profileValue(profile, { small: 100, standard: 250, highThroughput: 1000 }),
          100_000
        ),
      maxReportResults:
        this.janitorConfig.maxReportResults ??
        readResourceLimit(
          prefix,
          'JANITOR_MAX_REPORT_RESULTS',
          profileValue(profile, { small: 500, standard: 1000, highThroughput: 5000 }),
          1_000_000
        )
    })
  }

  /** Ban a domain and remove all its SHIP/SLAP records from MongoDB. */
  private async handleBanDomain(
    res: express.Response,
    value: string,
    reason?: string
  ): Promise<express.Response> {
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
  private async handleBanOutpoint(
    res: express.Response,
    engine: Engine,
    value: string,
    reason?: string
  ): Promise<express.Response> {
    const dotIndex = value.lastIndexOf('.')
    if (dotIndex !== 64 || !/^(0|[1-9]\d*)$/.test(value.substring(dotIndex + 1))) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Outpoint format must be "txid.outputIndex"' })
    }
    const txid = value.substring(0, dotIndex)
    const outputIndex = Number(value.substring(dotIndex + 1))
    try {
      assertHash(txid, 'Outpoint txid')
      assertNonnegativeSafeInteger(outputIndex, 'Outpoint outputIndex')
      if (outputIndex > 0xffffffff) throw new TypeError('Outpoint outputIndex is too large')
    } catch {
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
  private async evictFromServices(
    engine: Engine,
    txid: string,
    outputIndex: number,
    service?: string
  ): Promise<void> {
    if (typeof service === 'string') {
      const svc = Object.prototype.hasOwnProperty.call(engine.lookupServices, service)
        ? engine.lookupServices[service]
        : undefined
      if (svc !== undefined) await svc.outputEvicted(txid, outputIndex)
      return
    }
    for (const svc of Object.values(engine.lookupServices)) {
      try {
        await svc.outputEvicted(txid, outputIndex)
      } catch {
        /* best-effort */
      }
    }
  }

  /** Look up the domain of an outpoint from SHIP or SLAP records. */
  private async lookupDomainForOutpoint(
    txid: string,
    outputIndex: number
  ): Promise<string | undefined> {
    const db = this.ensureMongo()
    const [shipRecord, slapRecord] = await Promise.all([
      db.collection('shipRecords').findOne({ txid, outputIndex }),
      db.collection('slapRecords').findOne({ txid, outputIndex })
    ])
    return (shipRecord?.domain ?? slapRecord?.domain) as string | undefined
  }

  /** Ban a domain and delete all SHIP/SLAP records for it. */
  private async banDomainAndRemoveRecords(domain: string, reason: string): Promise<void> {
    await this.banService!.banDomain(domain, reason)
    const db = this.ensureMongo()
    await Promise.all([
      db.collection('shipRecords').deleteMany({ domain }),
      db.collection('slapRecords').deleteMany({ domain })
    ])
  }

  private async runHealthCheck(
    definition: Required<Pick<HealthCheckDefinition, 'name' | 'scope' | 'critical'>> & {
      handler: HealthCheckHandler
    }
  ): Promise<HealthCheckResult> {
    const startedAt = Date.now()
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      const result = ((await Promise.race([
        Promise.resolve().then(async () => await definition.handler()),
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

      if (
        typeof result !== 'object' ||
        result === null ||
        (result.status !== undefined && !['ok', 'degraded', 'error'].includes(result.status)) ||
        (result.message !== undefined &&
          (typeof result.message !== 'string' ||
            new TextEncoder().encode(result.message).byteLength > MAX_HEALTH_MESSAGE_BYTES))
      ) {
        throw new TypeError('Health check returned an invalid result')
      }
      const details =
        result.details === undefined
          ? undefined
          : this.cloneBoundedHealthData(result.details, 'Health check details')

      return {
        name: definition.name,
        scope: definition.scope,
        critical: definition.critical,
        status: result.status ?? 'ok',
        message: result.message,
        details,
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

  private cloneBoundedHealthData(value: unknown, label: string): Record<string, any> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`${label} must be an object`)
    }
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(value)
    } catch {
      throw new TypeError(`${label} must be JSON serializable`)
    }
    if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable`)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_HEALTH_REPORT_DATA_BYTES) {
      throw new RangeError(`${label} exceeds ${MAX_HEALTH_REPORT_DATA_BYTES} bytes`)
    }
    return JSON.parse(serialized) as Record<string, any>
  }

  private async collectHealthReport(mode: 'live' | 'ready' | 'full'): Promise<HealthReport> {
    const definitions: Array<
      Required<Pick<HealthCheckDefinition, 'name' | 'scope' | 'critical'>> & {
        handler: HealthCheckHandler
      }
    > = [
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

    const filteredDefinitions = definitions.filter(definition => {
      if (mode === 'full') {
        return true
      }

      return definition.scope === mode
    })

    const checks = await Promise.all(
      filteredDefinitions.map(async definition => await this.runHealthCheck(definition))
    )
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

    let context: Record<string, any> | undefined
    if (
      mode === 'full' &&
      this.healthConfig.includeDetails &&
      typeof this.healthConfig.contextProvider === 'function'
    ) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const suppliedContext = await Promise.race([
          Promise.resolve().then(async () => await this.healthConfig.contextProvider?.()),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Timed out after ${this.healthConfig.timeoutMs}ms`)),
              this.healthConfig.timeoutMs
            )
          })
        ])
        context =
          suppliedContext === undefined
            ? undefined
            : this.cloneBoundedHealthData(suppliedContext, 'Health context')
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    }

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
  private formatBodyForLog(body: any, okPrefix: string): string {
    if (Buffer.isBuffer(body)) {
      return chalk.green(`${okPrefix} binary body (${serializeLogValue(body.byteLength)} bytes)`)
    }
    if (typeof body === 'string') {
      return chalk.green(
        `${okPrefix} string body (${serializeLogValue(Buffer.byteLength(body, 'utf8'))} bytes)`
      )
    }
    if (body != null && typeof body === 'object') {
      const keys = Array.isArray(body) ? body.length : Object.keys(body).length
      return chalk.green(
        `${okPrefix} structured body (${serializeLogValue(keys)} top-level item(s))`
      )
    }
    return chalk.green(`${okPrefix} type=${serializeLogValue(typeof body)}`)
  }

  private redactHeadersForLog(headers: Record<string, any>): Record<string, any> {
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
    return undefined
  }

  private arcCallbackAuthorized(req: Request): boolean {
    if (typeof this.arcCallbackToken !== 'string' || this.arcCallbackToken.length === 0) {
      return false
    }
    const callbackHeader = req.headers['x-callback-token']
    const callbackToken = Array.isArray(callbackHeader) ? callbackHeader[0] : callbackHeader
    return [this.arcCallbackRequestToken(req), callbackToken].some(
      candidate => typeof candidate === 'string' && secretMatches(candidate, this.arcCallbackToken!)
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
  private setupVerboseRequestLogging(): void {
    this.app.use((req, res, next) => {
      const startTime = Date.now()

      // Log incoming request details
      this.logger.log(
        chalk.magenta.bold(
          `Incoming Request: method=${serializeLogValue(req.method)} url=${serializeLogValue(req.originalUrl)}`
        )
      )
      this.logger.log(
        chalk.cyan(`Headers: ${serializeLogValue(this.redactHeadersForLog(req.headers))}`)
      )

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
        this.logger.log(
          chalk.cyan(
            `Response Headers: ${serializeLogValue(this.redactHeadersForLog(res.getHeaders()))}`
          )
        )

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
  async start(): Promise<void> {
    const engine = this.ensureEngine()
    const knex = this.ensureKnex()
    const hasConfiguredArcProvider =
      (typeof this.arcApiKey === 'string' && this.arcApiKey.length > 0) ||
      (typeof this.arcadeUrl === 'string' && this.arcadeUrl.length > 0)
    if (
      hasConfiguredArcProvider &&
      (typeof this.arcCallbackToken !== 'string' || this.arcCallbackToken.length === 0)
    ) {
      throw new Error(
        'ARC/Arcade is configured without an ARC callback token; configureArcCallbackToken is required'
      )
    }
    this.startTime = new Date()

    const edgePolicy = this.edgePolicyConfig
    const resourceProfile = readResourceProfile(edgePolicy.environmentPrefix)
    const maxResponseBytes = readResourceLimit(
      edgePolicy.environmentPrefix,
      'MAX_RESPONSE_BYTES',
      profileValue(resourceProfile, {
        small: 4 * 1024 * 1024,
        standard: 8 * 1024 * 1024,
        highThroughput: 32 * 1024 * 1024
      }),
      512 * 1024 * 1024
    )
    const maxBasmTxids = readResourceLimit(
      edgePolicy.environmentPrefix,
      'MAX_BASM_TXIDS',
      profileValue(resourceProfile, { small: 500, standard: 1000, highThroughput: 5000 }),
      1_000_000
    )
    const maxBasmAnchorRange = readResourceLimit(
      edgePolicy.environmentPrefix,
      'MAX_BASM_ANCHOR_RANGE',
      profileValue(resourceProfile, { small: 500, standard: 1000, highThroughput: 5000 }),
      1_000_000
    )
    const adminListDefaultLimit = readResourceLimit(
      edgePolicy.environmentPrefix,
      'ADMIN_LIST_DEFAULT_LIMIT',
      profileValue(resourceProfile, { small: 25, standard: 50, highThroughput: 100 }),
      1_000_000
    )
    const adminListMaxLimit = readResourceLimit(
      edgePolicy.environmentPrefix,
      'ADMIN_LIST_MAX_LIMIT',
      profileValue(resourceProfile, { small: 100, standard: 200, highThroughput: 1000 }),
      1_000_000
    )
    const adminListMaxOffset = readResourceLimit(
      edgePolicy.environmentPrefix,
      'ADMIN_LIST_MAX_OFFSET',
      profileValue(resourceProfile, {
        small: 10_000,
        standard: 100_000,
        highThroughput: 1_000_000
      }),
      100_000_000
    )
    if (
      adminListDefaultLimit !== -1 &&
      adminListMaxLimit !== -1 &&
      adminListDefaultLimit > adminListMaxLimit
    ) {
      throw new TypeError(
        'OVERLAY_ADMIN_LIST_DEFAULT_LIMIT cannot exceed OVERLAY_ADMIN_LIST_MAX_LIMIT'
      )
    }
    const parseAdminPage = (
      rawPageValue: unknown,
      rawLimitValue: unknown
    ): { page: number; limit: number; skip: number } => {
      const rawPageText = typeof rawPageValue === 'string' ? rawPageValue.trim() : ''
      if (rawPageText.length > 0 && !/^[1-9]\d*$/.test(rawPageText)) {
        throw new TypeError('page must be a positive integer')
      }
      const requestedPage = rawPageText.length === 0 ? 1 : Number(rawPageText)
      if (!Number.isSafeInteger(requestedPage)) {
        throw new TypeError('page must be a positive safe integer')
      }
      const rawLimitText =
        typeof rawLimitValue === 'string' ? rawLimitValue.trim().toLowerCase() : ''
      if (
        rawLimitText.length > 0 &&
        rawLimitText !== '-1' &&
        rawLimitText !== 'unlimited' &&
        !/^[1-9]\d*$/.test(rawLimitText)
      ) {
        throw new TypeError('limit must be a positive integer, -1, or unlimited')
      }
      const parsedLimit =
        rawLimitText === '-1' || rawLimitText === 'unlimited' ? -1 : Number(rawLimitText)
      const requestedLimit = rawLimitText.length === 0 ? adminListDefaultLimit : parsedLimit
      if (requestedLimit !== -1 && (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)) {
        throw new TypeError('limit must be a positive integer, -1, or unlimited')
      }
      let limit = requestedLimit
      if (adminListMaxLimit !== -1) {
        limit =
          requestedLimit === -1 ? adminListMaxLimit : Math.min(requestedLimit, adminListMaxLimit)
      }
      const page = limit === -1 ? 1 : requestedPage
      const skip = limit === -1 ? 0 : (page - 1) * limit
      if (!Number.isSafeInteger(skip) || (adminListMaxOffset !== -1 && skip > adminListMaxOffset)) {
        throw new TypeError('requested page exceeds the configured maximum offset')
      }
      return { page, limit, skip }
    }
    const parseAdminSearch = (rawSearchValue: unknown): string | undefined => {
      if (rawSearchValue === undefined) return undefined
      assertBoundedString(rawSearchValue, 'search', 256)
      const search = rawSearchValue.trim()
      if (search.length === 0) return undefined
      for (const character of search) {
        const codePoint = character.codePointAt(0) ?? 0
        if (codePoint <= 0x1f || codePoint === 0x7f) {
          throw new TypeError('search must not contain control characters')
        }
      }
      // Search is literal. Treating authenticated operator input as a MongoDB
      // regular expression still enables catastrophic backtracking and broad
      // accidental scans when an admin token or browser is compromised.
      return search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    this.app.disable('x-powered-by')
    this.app.use(initialDoubleSlashCompatibility)
    this.app.use(
      securityHeaders({
        ...edgePolicy.securityHeaders,
        environmentPrefix: edgePolicy.environmentPrefix
      })
    )
    this.app.use(
      corsPolicy({
        environmentPrefix: edgePolicy.environmentPrefix,
        allowedOrigins: edgePolicy.allowedOrigins,
        methods: ['GET', 'POST', 'OPTIONS']
      })
    )
    this.app.use(
      concurrencyLimit(
        edgePolicy.environmentPrefix,
        edgePolicy.maxConcurrentRequests === 200
          ? profileValue(resourceProfile, { small: 8, standard: 24, highThroughput: 96 })
          : edgePolicy.maxConcurrentRequests
      )
    )
    this.app.use(
      bodyParser.json({
        limit: readBodyLimitBytes(
          `${edgePolicy.environmentPrefix}_JSON`,
          edgePolicy.jsonBodyLimitBytes
        ),
        type: 'application/json'
      })
    )
    this.app.use(
      bodyParser.raw({
        limit: readBodyLimitBytes(
          `${edgePolicy.environmentPrefix}_BINARY`,
          edgePolicy.binaryBodyLimitBytes
        ),
        type: 'application/octet-stream'
      })
    )
    this.app.use(bodyParserErrorHandler)
    this.app.use(responseSizeLimit(edgePolicy.environmentPrefix, maxResponseBytes))

    if (this.verboseRequestLogging) {
      this.setupVerboseRequestLogging()
    }

    // Serve a static documentation site or user interface
    this.app.get('/', (req, res) => {
      const scriptNonce = randomBytes(18).toString('base64')
      res.set('content-type', 'text/html')
      res.set(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${scriptNonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' https://cdn.jsdelivr.net; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      )
      res.send(
        makeUserInterface({
          ...this.webUIConfig,
          adminIdentityKey: this.adminIdentityKey,
          scriptNonce
        })
      )
    })

    // Serve health check endpoints
    this.app.get('/health/live', (_, res) => {
      res.set('Cache-Control', 'no-store, max-age=0')
      res.set('Pragma', 'no-cache')
      ;(async () => {
        const report = await this.collectHealthReport('live')
        return res.status(report.live ? 200 : 503).json(report)
      })().catch(error => {
        this.logger.error({ operation: 'overlay.health_live', error })
        res.status(500).json({
          status: 'error',
          message: 'Health report unavailable'
        })
      })
    })

    // Compatibility alias used by Kubernetes probes and existing deployments.
    this.app.get('/healthz', (_, res) => {
      res.set('Cache-Control', 'no-store, max-age=0')
      res.set('Pragma', 'no-cache')
      ;(async () => {
        const report = await this.collectHealthReport('live')
        return res.status(report.live ? 200 : 503).json(report)
      })().catch(error => {
        this.logger.error({ operation: 'overlay.healthz', error })
        res.status(500).json({ status: 'error', message: 'Health report unavailable' })
      })
    })

    this.app.get('/health/ready', (_, res) => {
      res.set('Cache-Control', 'no-store, max-age=0')
      res.set('Pragma', 'no-cache')
      ;(async () => {
        const report = await this.collectHealthReport('ready')
        return res.status(report.ready ? 200 : 503).json(report)
      })().catch(error => {
        this.logger.error({ operation: 'overlay.health_ready', error })
        res.status(500).json({
          status: 'error',
          message: 'Health report unavailable'
        })
      })
    })

    this.app.get('/health', (_, res) => {
      res.set('Cache-Control', 'no-store, max-age=0')
      res.set('Pragma', 'no-cache')
      ;(async () => {
        const report = await this.collectHealthReport('full')
        return res.status(report.ready ? 200 : 503).json(report)
      })().catch(error => {
        this.logger.error({ operation: 'overlay.health_full', error })
        res.status(500).json({
          status: 'error',
          message: 'Health report unavailable'
        })
      })
    })

    // List hosted topic managers and lookup services
    this.app.get('/listTopicManagers', (_, res) => {
      ;(async () => {
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
      ;(async () => {
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
      ;(async () => {
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
      ;(async () => {
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
      ;(async () => {
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
            const r = new Reader(beef)
            const l = r.readVarIntNumStrict(false)
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
          const steak = await engine.submit(
            taggedBEEF,
            (steak: STEAK) => {
              responseSent = true
              return res.status(200).json(steak)
            },
            'current-tx',
            offChainValues
          )
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
      ;(async () => {
        try {
          // Check for aggregation header to determine response format
          const aggregationHeader = req.headers['x-aggregation']
          const shouldReturnBinary = aggregationHeader === 'yes'

          // Validate request body structure
          const lookupRequest = req.body as { service: string; query: unknown }
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
          const writer = new Writer()

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
            if (output.context != null && output.context.length > 0) {
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
    const hasArcProvider =
      (typeof this.arcApiKey === 'string' && this.arcApiKey.length > 0) ||
      (typeof this.arcadeUrl === 'string' && this.arcadeUrl.length > 0)
    const hasArcCallbackToken =
      typeof this.arcCallbackToken === 'string' && this.arcCallbackToken.length > 0
    if (hasArcProvider && hasArcCallbackToken) {
      this.app.post('/arc-ingest', (req, res) => {
        ;(async () => {
          try {
            return await this.processArcIngest(engine, req, res)
          } catch (error) {
            this.logger.error(
              chalk.red(`Error in /arc-ingest: error=${serializeErrorForLog(error)}`)
            )
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
    } else if (!hasArcProvider) {
      this.logger.warn(
        chalk.yellow('Disabling ARC/Arcade ingest because no provider was configured.')
      )
    }

    // GASP sync routes if enabled
    if (this.enableGASPSync) {
      this.app.post('/requestSyncResponse', (req, res) => {
        ;(async () => {
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
        ;(async () => {
          try {
            const { graphID, txid, outputIndex } = req.body
            const header = req.headers['x-bsv-topic']
            if (typeof header !== 'string' || header.length === 0) {
              throw new PublicRequestError('Missing x-bsv-topic header')
            }
            const response = await engine.provideForeignGASPNode(graphID, txid, outputIndex, header)
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
      this.app.post(
        path,
        ...(middleware as any[]),
        (req: express.Request, res: express.Response) => {
          ;(async () => {
            try {
              return res.status(200).json(await handler(req))
            } catch (error) {
              console.error(chalk.red(`Error in ${path}:`), error)
              if (error instanceof Error && 'code' in error && error.code === 'BASM_UNSUPPORTED') {
                return res.status(400).json({
                  status: 'error',
                  message: 'BASM capability is not supported by this Overlay engine',
                  code: error.code
                })
              }
              return res.status(400).json({
                status: 'error',
                message: publicErrorMessage(error)
              })
            }
          })().catch(() => {
            res.status(500).json({ status: 'error', message: 'Unexpected error' })
          })
        }
      )
    }

    type BasmCapability =
      | 'provideTopicAnchorTip'
      | 'provideTopicAnchorRange'
      | 'provideAdmittedList'
      | 'provideCompoundMerklePath'
      | 'provideRawTransactions'
    const requireBasmCapability = (capability: BasmCapability): void => {
      if (typeof (engine as Partial<BASMCapableEngine>)[capability] !== 'function') {
        throw new UnsupportedBasmCapabilityError()
      }
    }

    const requireBasmHeight = (value: unknown, field: string): number => {
      if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        (typeof value === 'string' && value.trim().length === 0)
      ) {
        throw new PublicRequestError(`${field} must be a nonnegative safe integer`)
      }
      const height = Number(value)
      if (!Number.isSafeInteger(height) || height < 0) {
        throw new PublicRequestError(`${field} must be a nonnegative safe integer`)
      }
      return height
    }

    const requireBlockHash = (value: unknown): string | undefined => {
      if (value === undefined) return undefined
      if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new PublicRequestError('blockHash must be a 32-byte hexadecimal string')
      }
      return value.toLowerCase()
    }

    const requireTxids = (value: unknown, requireAtLeastOne: boolean = true): string[] => {
      if (!Array.isArray(value) || (requireAtLeastOne && value.length === 0)) {
        throw new PublicRequestError('txids must be a non-empty array')
      }
      if (maxBasmTxids !== -1 && value.length > maxBasmTxids) {
        throw new PublicRequestError(`txids must contain at most ${maxBasmTxids} entries`)
      }
      const seen = new Set<string>()
      const txids: string[] = []
      for (const txid of value) {
        if (typeof txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(txid)) {
          throw new PublicRequestError('txids must contain 32-byte hexadecimal transaction IDs')
        }
        const normalized = txid.toLowerCase()
        if (seen.has(normalized)) {
          throw new PublicRequestError('txids must not contain duplicates')
        }
        seen.add(normalized)
        txids.push(normalized)
      }
      return txids
    }

    registerJsonRoute('/requestTopicAnchorTip', async req => {
      requireBasmCapability('provideTopicAnchorTip')
      return await basmEngine.provideTopicAnchorTip(readBasmTopic(req))
    })

    registerJsonRoute('/requestTopicAnchorRange', async req => {
      const { fromHeight, toHeight } = req.body
      const from = requireBasmHeight(fromHeight, 'fromHeight')
      const to = requireBasmHeight(toHeight, 'toHeight')
      if (to < from) {
        throw new PublicRequestError('fromHeight and toHeight must define a valid ascending range')
      }
      if (maxBasmAnchorRange !== -1 && to - from + 1 > maxBasmAnchorRange) {
        throw new PublicRequestError(
          `topic anchor range must contain at most ${maxBasmAnchorRange} blocks`
        )
      }
      requireBasmCapability('provideTopicAnchorRange')
      return await basmEngine.provideTopicAnchorRange(readBasmTopic(req), from, to)
    })

    registerJsonRoute('/requestAdmittedList', async req => {
      const { blockHeight, blockHash } = req.body
      const height = requireBasmHeight(blockHeight, 'blockHeight')
      const hash = requireBlockHash(blockHash)
      requireBasmCapability('provideAdmittedList')
      return await basmEngine.provideAdmittedList(readBasmTopic(req), height, hash)
    })

    registerJsonRoute('/requestCompoundMerklePath', async req => {
      const topic = readBasmTopic(req)
      const { blockHeight, txids } = req.body
      const height = requireBasmHeight(blockHeight, 'blockHeight')
      const requestedTxids = requireTxids(txids)
      requireBasmCapability('provideCompoundMerklePath')
      return await basmEngine.provideCompoundMerklePath(topic, height, requestedTxids)
    })

    registerJsonRoute('/requestRawTransactions', async req => {
      const topic = readBasmTopic(req)
      const txids = requireTxids(req.body.txids, false)
      requireBasmCapability('provideRawTransactions')
      return await basmEngine.provideRawTransactions(txids, topic)
    })

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
    const checkAdminAuth = (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ): void => {
      // Administrative responses contain sensitive operational state and must
      // never survive logout in browser, proxy, or shared-cache storage.
      res.setHeader('Cache-Control', 'no-store, max-age=0')
      res.setHeader('Pragma', 'no-cache')

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

      res.status(401).json({
        status: 'error',
        message: 'Unauthorized: Provide a Bearer token or authenticate with your wallet'
      })
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
      ;(async () => {
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
      ;(async () => {
        try {
          const db = this.ensureMongo()
          const collection = db.collection('shipRecords')

          const search = parseAdminSearch(req.query.search)
          const { page, limit, skip } = parseAdminPage(req.query.page, req.query.limit)

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
            (() => {
              let cursor = collection.find(query).sort({ createdAt: -1 }).skip(skip)
              if (limit !== -1) cursor = cursor.limit(limit)
              return cursor.toArray()
            })(),
            collection.countDocuments(query)
          ])

          return res.status(200).json({
            status: 'success',
            data: {
              records,
              total,
              page,
              limit,
              pages: limit === -1 ? 1 : Math.ceil(total / limit)
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
     * Admin route: List all SLAP records with full details.
     */
    this.app.get('/admin/slap-records', checkAdminAuth as any, (req, res) => {
      ;(async () => {
        try {
          const db = this.ensureMongo()
          const collection = db.collection('slapRecords')

          const search = parseAdminSearch(req.query.search)
          const { page, limit, skip } = parseAdminPage(req.query.page, req.query.limit)

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
            (() => {
              let cursor = collection.find(query).sort({ createdAt: -1 }).skip(skip)
              if (limit !== -1) cursor = cursor.limit(limit)
              return cursor.toArray()
            })(),
            collection.countDocuments(query)
          ])

          return res.status(200).json({
            status: 'success',
            data: {
              records,
              total,
              page,
              limit,
              pages: limit === -1 ? 1 : Math.ceil(total / limit)
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
     * Admin route: Check health of a specific URL.
     */
    this.app.post('/admin/health-check', checkAdminAuth as any, (req, res) => {
      ;(async () => {
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
      ;(async () => {
        try {
          if (this.banService === undefined) {
            return res.status(400).json({
              status: 'error',
              message: 'Ban service not available (MongoDB not configured)'
            })
          }

          const { type, value, reason } = req.body
          if (type !== 'domain' && type !== 'outpoint') {
            return res
              .status(400)
              .json({ status: 'error', message: 'type must be "domain" or "outpoint"' })
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
      ;(async () => {
        try {
          if (this.banService === undefined) {
            return res.status(400).json({ status: 'error', message: 'Ban service not available' })
          }
          const { type, value } = req.body as { type: unknown; value: unknown }
          if (type !== 'domain' && type !== 'outpoint') {
            return res
              .status(400)
              .json({ status: 'error', message: 'type must be "domain" or "outpoint"' })
          }
          if (typeof value !== 'string' || value.length === 0) {
            return res.status(400).json({ status: 'error', message: 'value is required' })
          }

          await this.banService.removeBan(type, value)
          return res
            .status(200)
            .json({ status: 'success', message: `${type} "${String(value)}" unbanned.` })
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
      ;(async () => {
        try {
          if (this.banService === undefined) {
            return res.status(200).json({ status: 'success', data: { bans: [] } })
          }
          const type = req.query.type as 'domain' | 'outpoint' | undefined
          const validType = type === 'domain' || type === 'outpoint' ? type : undefined
          const { page, limit, skip } = parseAdminPage(req.query.page, req.query.limit)
          const bans = await this.banService.listBans(validType, limit, skip)
          return res.status(200).json({ status: 'success', data: { bans, page, limit } })
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
      ;(async () => {
        try {
          const { txid, outputIndex, service, ban, banDomain: shouldBanDomain } = req.body
          try {
            assertHash(txid, 'txid')
            assertNonnegativeSafeInteger(outputIndex, 'outputIndex')
            if (outputIndex > 0xffffffff) throw new TypeError('outputIndex is too large')
          } catch {
            return res.status(400).json({
              status: 'error',
              message: 'txid and outputIndex must form a valid outpoint'
            })
          }
          if (service !== undefined && typeof service !== 'string') {
            return res.status(400).json({ status: 'error', message: 'service must be a string' })
          }

          // Look up domain before eviction if needed for banning
          let removedDomain: string | undefined
          if (shouldBanDomain === true || ban === true) {
            removedDomain = await this.lookupDomainForOutpoint(txid, outputIndex)
          }

          // Persist requested bans before eviction so a concurrent GASP sync
          // cannot re-admit the output during the administrative operation.
          if (ban === true && this.banService !== undefined) {
            await this.banService.banOutpoint(
              txid,
              outputIndex,
              'Manually removed by admin',
              removedDomain
            )
          }

          if (
            shouldBanDomain === true &&
            typeof removedDomain === 'string' &&
            this.banService !== undefined
          ) {
            await this.banDomainAndRemoveRecords(
              removedDomain,
              'Domain banned by admin via token removal'
            )
          }

          await this.evictFromServices(engine, txid, outputIndex, service)

          const banMsg = ban === true ? ' Outpoint banned.' : ''
          const domainMsg =
            shouldBanDomain === true && typeof removedDomain === 'string'
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
      ;(async () => {
        try {
          await engine.syncAdvertisements()
          return res
            .status(200)
            .json({ status: 'success', message: 'Advertisements synced successfully' })
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
      ;(async () => {
        try {
          await engine.startGASPSync()
          return res
            .status(200)
            .json({ status: 'success', message: 'GASP sync started and completed' })
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
    registerJsonRoute(
      '/admin/startBASMSync',
      async () => {
        const report = await basmEngine.startBASMSync()
        return { status: 'success', message: 'BASM sync started and completed', data: report }
      },
      checkAdminAuth as any
    )

    /**
     * Admin route to evict expired unproven topic transactions.
     */
    registerJsonRoute(
      '/admin/evictUnproven',
      async req => {
        const { topic, thresholdBlocks } = req.body ?? {}
        const report = await basmEngine.evictUnprovenTransactions({
          topic: typeof topic === 'string' ? topic : undefined,
          thresholdBlocks: typeof thresholdBlocks === 'number' ? thresholdBlocks : undefined
        })
        this.logger.log({ operation: 'overlay.unproven_eviction', outcome: 'ok', report })
        return { status: 'success', message: 'Unproven eviction completed', data: report }
      },
      checkAdminAuth as any
    )

    /**
     * Admin route to refresh proofs for expired unproven topic transactions
     * using the configured proof providers.
     */
    registerJsonRoute(
      '/admin/refreshUnprovenProofs',
      async req => {
        const { topic, thresholdBlocks } = req.body ?? {}
        const report = await basmEngine.refreshUnprovenTransactionProofs({
          topic: typeof topic === 'string' ? topic : undefined,
          thresholdBlocks: typeof thresholdBlocks === 'number' ? thresholdBlocks : undefined,
          proofProvider: async txid => await this.fetchConfiguredMerkleProof(txid)
        })
        this.logger.log({ operation: 'overlay.unproven_proof_refresh', outcome: 'ok', report })
        return { status: 'success', message: 'Unproven proof refresh completed', data: report }
      },
      checkAdminAuth as any
    )

    /**
     * Admin route to refresh proofs first, then evict rows that remain unproven.
     */
    registerJsonRoute(
      '/admin/maintainUnproven',
      async req => {
        const { topic, thresholdBlocks } = req.body ?? {}
        const report = await basmEngine.maintainUnprovenTransactions({
          topic: typeof topic === 'string' ? topic : undefined,
          thresholdBlocks: typeof thresholdBlocks === 'number' ? thresholdBlocks : undefined,
          proofProvider: async txid => await this.fetchConfiguredMerkleProof(txid)
        })
        this.logger.log({ operation: 'overlay.unproven_maintenance', outcome: 'ok', report })
        return { status: 'success', message: 'Unproven maintenance completed', data: report }
      },
      checkAdminAuth as any
    )

    /**
     * Admin route to evict an outpoint, either from all services or a specific one.
     */
    this.app.post('/admin/evictOutpoint', checkAdminAuth as any, (req, res) => {
      ;(async () => {
        try {
          const { txid, outputIndex, service } = req.body ?? {}
          assertHash(txid, 'txid')
          assertNonnegativeSafeInteger(outputIndex, 'outputIndex')
          if (outputIndex > 0xffffffff) throw new TypeError('outputIndex is too large')
          if (service !== undefined) {
            assertBoundedString(service, 'service', 256, false)
            if (!Object.prototype.hasOwnProperty.call(engine.lookupServices, service)) {
              throw new TypeError('service must name a configured lookup service')
            }
          }
          await this.evictFromServices(engine, txid, outputIndex, service)
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
      ;(async () => {
        try {
          const janitor = this.createJanitor()
          const report: JanitorReport = await janitor.run()
          return res
            .status(200)
            .json({ status: 'success', message: 'Janitor run completed', data: report })
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
      this.logger.log(
        chalk.green.bold(`${this.name} is ready and listening on local port ${this.port}`)
      )
    })
    configureHttpServer(this.server, edgePolicy.environmentPrefix, edgePolicy.http)
  }

  /**
   * Stops new HTTP work, background synchronization, and database clients.
   *
   * The operation is idempotent so multiple signal handlers or embedding
   * runtimes can share shutdown ownership safely.
   */
  async close(): Promise<void> {
    this.closePromise ??= this.closeResources()
    await this.closePromise
  }

  private async closeResources(): Promise<void> {
    this.isListening = false

    if (this.basmBlockPollTimer !== undefined) {
      clearInterval(this.basmBlockPollTimer)
      this.basmBlockPollTimer = undefined
    }
    if (this.unprovenMaintenanceTimer !== undefined) {
      clearInterval(this.unprovenMaintenanceTimer)
      this.unprovenMaintenanceTimer = undefined
    }
    this.reorgAdapter?.stop()
    this.reorgAdapter = undefined

    const server = this.server
    this.server = undefined
    const closeServer =
      server === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            server.close(error => {
              if (error !== undefined) reject(error)
              else resolve()
            })
          })

    await closeServer
    await Promise.all([
      this.knex?.destroy() ?? Promise.resolve(),
      this.mongoClient?.close() ?? Promise.resolve()
    ])
    this.knex = undefined
    this.mongoClient = undefined
    this.mongoDb = undefined
  }

  /**
   * Runs the post-listen startup work: advertiser init, advertisement sync,
   * and the optional GASP/BASM background syncs.
   */
  private async runStartupSync(): Promise<void> {
    // The legacy Ninja advertiser has a setLookupEngine method.
    if (this.engine?.advertiser instanceof WalletAdvertiser) {
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
  private async runGaspStartupSync(): Promise<void> {
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
  private async runBasmStartupSync(): Promise<void> {
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
  private startBASMBlockPolling(): void {
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
  private startBASMReorgStream(): void {
    const reorgStreamUrl = this.engineConfig.reorgStreamUrl ?? this.reorgStreamUrl
    const reorgScanDepth = this.engineConfig.reorgScanDepth ?? this.reorgScanDepth
    if (reorgStreamUrl === undefined || reorgStreamUrl === '') {
      return
    }
    const basmEngine = this.engine as BASMCapableEngine | undefined
    this.reorgAdapter = new ReorgSseAdapter({
      url: reorgStreamUrl,
      onReorg: async input => {
        await basmEngine?.handleReorg(input)
      },
      onConnect: async () => {
        await basmEngine?.revalidateRecentAnchors(reorgScanDepth)
      },
      logger: this.logger,
      allowPrivateHosts:
        this.engineConfig.reorgStreamAllowPrivateHosts ?? this.reorgStreamAllowPrivateHosts
    })
    this.reorgAdapter.start()
    this.logger.log(chalk.green(`BASM reorg stream listening at ${reorgStreamUrl}`))
  }

  /** Extend every topic's BASM anchor chain to the current chain tip. */
  private async advanceBASMAnchorChains(): Promise<void> {
    try {
      await (this.engine as BASMCapableEngine | undefined)?.advanceTopicAnchorChains()
    } catch (e) {
      console.error(chalk.red('Failed to advance BASM anchor chains'), e)
    }
  }

  /** Revalidate recent BASM anchors against the chain tracker, reconciling any reorg. */
  private async revalidateBASMAnchors(): Promise<void> {
    try {
      const depth = this.engineConfig.reorgScanDepth ?? this.reorgScanDepth
      await (this.engine as BASMCapableEngine | undefined)?.revalidateRecentAnchors(depth)
    } catch (e) {
      console.error(chalk.red('Failed to revalidate BASM anchors'), e)
    }
  }

  private startUnprovenMaintenance(): void {
    const intervalMs =
      this.engineConfig.unprovenMaintenanceIntervalMs ?? this.unprovenMaintenanceIntervalMs
    if (intervalMs <= 0) return
    const run = (): void => {
      void (async () => {
        try {
          const report = await (
            this.engine as BASMCapableEngine | undefined
          )?.maintainUnprovenTransactions({
            thresholdBlocks:
              this.engineConfig.unprovenEvictionBlocks ?? this.unprovenEvictionBlocks,
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
