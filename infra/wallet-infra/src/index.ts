import {
  Services,
  MockServices,
  StorageKnex,
  TableSettings,
  WalletStorageManager,
  WalletStorageServerOptions,
  StorageServer,
  Wallet,
  Monitor,
  MonitorDaemon,
  AdminServer,
  type MonitorStartupTaskMode,
  KnexSessionManager,
  WalletLogger,
  type WalletLoggerLevel,
  type WalletArgs
} from '@bsv/wallet-toolbox'
import EventSource from 'eventsource'
import knexPkg from 'knex'
const { knex: makeKnex } = knexPkg
import type { Knex } from 'knex'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import packageJson from '../package.json' with { type: 'json' }
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { log } from './logger.js'
import { KnexPaymentReplayStore } from './KnexPaymentReplayStore.js'

import * as dotenv from 'dotenv'
dotenv.config()

type WalletKeyDeriver = WalletArgs['keyDeriver']
type WalletLookupResolver = NonNullable<WalletArgs['lookupResolver']>

interface CjsSdk {
  PrivateKey: {
    fromHex: (hex: string) => {
      toPublicKey: () => { toString: () => string }
    }
  }
  KeyDeriver: new (rootKey: unknown) => WalletKeyDeriver
  LookupResolver: new (options: {
    networkPreset: 'local' | 'mainnet' | 'testnet'
  }) => WalletLookupResolver
}

// wallet-toolbox is CommonJS and therefore resolves @bsv/sdk's require
// condition. Load the SDK through the same condition so nominal classes with
// private fields do not split across the ESM and CommonJS declaration graphs.
const { PrivateKey, KeyDeriver, LookupResolver } = createRequire(
  import.meta.url
)('@bsv/sdk') as CjsSdk

const tracer = trace.getTracer(packageJson.name, packageJson.version)
let shutdownPromise: Promise<void> | undefined

const closeHttpServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) =>
      error === undefined ? resolve() : reject(error)
    )
  })
}

// Load environment variables
const {
  ENABLE_NGINX = 'true',
  HTTP_PORT = 8081, // Must be 8081 if ENABLE_NGINX 'true',
  SERVER_PRIVATE_KEY,
  TAAL_API_KEY,
  WHATSONCHAIN_API_KEY,
  BITAILS_API_KEY,
  ARCADE_URL,
  ARCADE_API_KEY,
  ARCADE_CALLBACK_TOKEN,
  EXCHANGERATESAPI_KEY,
  COMMISSION_FEE = 0,
  COMMISSION_PUBLIC_KEY,
  FEE_MODEL = '{"model":"sat/kb","value":1}',
  LOGGER_LEVEL
} = process.env

const BSV_NETWORK = process.env.BSV_NETWORK ?? process.env.CHAIN ?? 'main'

function readKnexDatabaseConnection(network: string): string | undefined {
  if (process.env.KNEX_DB_CONNECTION != null) {
    return process.env.KNEX_DB_CONNECTION
  }
  if (network === 'main') return process.env.MAIN_KNEX_DB_CONNECTION
  if (network === 'test') return process.env.TEST_KNEX_DB_CONNECTION
  return undefined
}

const KNEX_DB_CONNECTION = readKnexDatabaseConnection(BSV_NETWORK)

type WalletInfraRole = 'all' | 'api' | 'monitor'

interface MonitorAdminConfig {
  host: string
  port: number
  privateKey: string
  identityKeys: string[]
  allowedOrigins?: string[]
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  if (!/^[1-9]\d*$/.test(raw))
    throw new Error(`${name} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} must be a safe integer`)
  return value
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  if (!/^\d+$/.test(raw))
    throw new Error(`${name} must be a non-negative integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} must be a safe integer`)
  return value
}

function readPort(name: string, fallback: number): number {
  const value = readPositiveInteger(name, fallback)
  if (value > 65_535) throw new Error(`${name} must be between 1 and 65535`)
  return value
}

function readOptionalProxyHops(): number | undefined {
  const raw = process.env.WALLET_STORAGE_TRUST_PROXY_HOPS
  if (raw == null || raw.trim() === '') return undefined
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      'WALLET_STORAGE_TRUST_PROXY_HOPS must be a non-negative integer'
    )
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > 10) {
    throw new Error('WALLET_STORAGE_TRUST_PROXY_HOPS must be between 0 and 10')
  }
  return value
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function readStorageBindHost(): string {
  const configured = process.env.WALLET_STORAGE_BIND_HOST?.trim()
  if (configured != null && configured !== '') return configured
  return ENABLE_NGINX === 'true' ? '127.0.0.1' : '0.0.0.0'
}

function readRole(): WalletInfraRole {
  const explicitRole = process.env.WALLET_INFRA_ROLE?.trim().toLowerCase()
  const legacyMonitorRole =
    explicitRole == null &&
    process.env.ADMIN_PORT != null &&
    process.env.ADMIN_PORT.trim() !== '' &&
    process.env.WALLET_STORAGE_MONITOR_ADMIN_ENABLED?.trim().toLowerCase() !==
      'false'
  const role = explicitRole ?? (legacyMonitorRole ? 'monitor' : 'all')
  if (role !== 'all' && role !== 'api' && role !== 'monitor') {
    throw new Error('WALLET_INFRA_ROLE must be all, api, or monitor')
  }
  return role
}

function readMonitorStartupTaskMode(): MonitorStartupTaskMode {
  const mode = (
    process.env.WALLET_STORAGE_MONITOR_STARTUP_TASK_MODE ??
    process.env.MONITOR_STARTUP_TASK_MODE ??
    'default'
  )
    .trim()
    .toLowerCase()
  if (
    mode === 'none' ||
    mode === 'default' ||
    mode === 'multiuser' ||
    mode === 'alltoother'
  ) {
    return mode
  }
  throw new Error(
    'WALLET_STORAGE_MONITOR_STARTUP_TASK_MODE must be none, default, multiuser, or alltoother'
  )
}

function readMonitorTasksEnabled(): boolean {
  const raw =
    process.env.WALLET_STORAGE_MONITOR_START_TASKS ??
    process.env.MONITOR_START_TASKS
  if (raw == null || raw.trim() === '') return true
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new Error(
    'WALLET_STORAGE_MONITOR_START_TASKS must be true/false, 1/0, yes/no, or on/off'
  )
}

function decodeJsonSetting(name: string, raw: string): string {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    candidates.push(Buffer.from(trimmed, 'base64').toString('utf8').trim())
  }
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // Try the next representation.
    }
  }
  throw new Error(`${name} must contain JSON or base64-encoded JSON`)
}

function readAdminIdentityKeys(): string[] | undefined {
  const raw =
    process.env.WALLET_STORAGE_ADMIN_IDENTITY_KEYS ??
    process.env.ADMIN_IDENTITY_KEYS
  if (raw == null || raw.trim() === '') return undefined
  const direct = raw.split(',').map(value => value.trim())
  const decoded = direct.every(value => /^(02|03)[0-9a-fA-F]{64}$/.test(value))
    ? direct
    : Buffer.from(raw, 'base64')
        .toString('utf8')
        .split(',')
        .map(value => value.trim())
  if (!decoded.every(value => /^(02|03)[0-9a-fA-F]{64}$/.test(value))) {
    throw new Error(
      'WALLET_STORAGE_ADMIN_IDENTITY_KEYS must contain comma-separated compressed public keys or their base64 encoding'
    )
  }
  return [...new Set(decoded.map(value => value.toLowerCase()))]
}

function readOptionalCsv(
  name: string,
  fallbackName?: string
): string[] | undefined {
  const raw =
    process.env[name] ??
    (fallbackName == null ? undefined : process.env[fallbackName])
  if (raw == null || raw.trim() === '') return undefined
  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  return values.length === 0 ? undefined : [...new Set(values)]
}

function readMonitorAdminConfig(
  role: WalletInfraRole
): MonitorAdminConfig | undefined {
  const legacyEnabled =
    process.env.ADMIN_PORT != null && process.env.ADMIN_PORT.trim() !== ''
  const enabled = readBoolean(
    'WALLET_STORAGE_MONITOR_ADMIN_ENABLED',
    legacyEnabled
  )
  if (!enabled) return undefined
  if (role === 'api') {
    throw new Error(
      'WALLET_STORAGE_MONITOR_ADMIN_ENABLED requires WALLET_INFRA_ROLE=monitor or all'
    )
  }

  const identityKeys = readAdminIdentityKeys() ?? []
  if (identityKeys.length === 0) {
    throw new Error(
      'WALLET_STORAGE_MONITOR_ADMIN_ENABLED requires WALLET_STORAGE_ADMIN_IDENTITY_KEYS or ADMIN_IDENTITY_KEYS'
    )
  }

  const privateKey =
    process.env.WALLET_STORAGE_MONITOR_ADMIN_PRIVATE_KEY ??
    process.env.ADMIN_ROOT_KEY_HEX ??
    SERVER_PRIVATE_KEY
  if (privateKey == null || privateKey.trim() === '') {
    throw new Error(
      'WALLET_STORAGE_MONITOR_ADMIN_ENABLED requires WALLET_STORAGE_MONITOR_ADMIN_PRIVATE_KEY, ADMIN_ROOT_KEY_HEX, or SERVER_PRIVATE_KEY'
    )
  }

  const portName =
    process.env.WALLET_STORAGE_MONITOR_ADMIN_PORT == null
      ? 'ADMIN_PORT'
      : 'WALLET_STORAGE_MONITOR_ADMIN_PORT'
  const port = readPort(portName, 8082)
  if (role === 'all' && port === Number(HTTP_PORT)) {
    throw new Error(
      'WALLET_STORAGE_MONITOR_ADMIN_PORT must differ from HTTP_PORT when WALLET_INFRA_ROLE=all'
    )
  }
  if (role === 'all' && ENABLE_NGINX === 'true' && port === 8080) {
    throw new Error(
      'WALLET_STORAGE_MONITOR_ADMIN_PORT must differ from the nginx listener port 8080 when WALLET_INFRA_ROLE=all'
    )
  }

  return {
    host:
      process.env.WALLET_STORAGE_MONITOR_ADMIN_HOST ??
      process.env.ADMIN_HOST ??
      '127.0.0.1',
    port,
    privateKey: privateKey.trim(),
    identityKeys,
    allowedOrigins: readOptionalCsv(
      'WALLET_STORAGE_MONITOR_ADMIN_ALLOWED_ORIGINS',
      'ADMIN_ALLOWED_ORIGINS'
    )
  }
}

function readWalletLoggerLevel(): WalletLoggerLevel | undefined {
  const raw = LOGGER_LEVEL?.trim().toLowerCase()
  if (raw == null || raw === '') return undefined
  if (!['error', 'warn', 'info', 'debug', 'trace'].includes(raw)) {
    throw new Error('LOGGER_LEVEL must be error, warn, info, debug, or trace')
  }
  return raw as WalletLoggerLevel
}

type WalletChain = 'main' | 'test' | 'ttn' | 'tstn' | 'mock'

function readWalletChain(): WalletChain {
  const allowedChains: WalletChain[] = ['main', 'test', 'ttn', 'tstn', 'mock']
  if (
    typeof BSV_NETWORK === 'string' &&
    allowedChains.includes(BSV_NETWORK as WalletChain)
  ) {
    return BSV_NETWORK as WalletChain
  }
  log.warn(
    {
      operation: 'chain.select',
      bsv_network: BSV_NETWORK,
      fallback_chain: 'main'
    },
    'Invalid BSV_NETWORK value provided, falling back to main'
  )
  return 'main'
}

function configuredServiceOptions(chain: Exclude<WalletChain, 'mock'>) {
  const options = Services.createDefaultOptions(chain)
  if (providerConfig.taalApiKey) {
    options.arcConfig.apiKey = providerConfig.taalApiKey
    options.taalApiKey = providerConfig.taalApiKey
  }
  if (providerConfig.whatsOnChainApiKey) {
    options.whatsOnChainApiKey = providerConfig.whatsOnChainApiKey
  }
  if (providerConfig.bitailsApiKey)
    options.bitailsApiKey = providerConfig.bitailsApiKey
  if (providerConfig.exchangeRatesApiKey) {
    options.exchangeratesapiKey = providerConfig.exchangeRatesApiKey
  }
  if (process.env.WALLET_STORAGE_TAAL_ARC_URL) {
    options.arcUrl = process.env.WALLET_STORAGE_TAAL_ARC_URL
  }
  let gorillaPoolDefault = true
  if (process.env.GORILLAPOOL_ARC_ENABLED != null) {
    gorillaPoolDefault = readBoolean('GORILLAPOOL_ARC_ENABLED', true)
  }
  const gorillaPoolEnabled = readBoolean(
    'WALLET_STORAGE_GORILLAPOOL_ARC_ENABLED',
    gorillaPoolDefault
  )
  if (!gorillaPoolEnabled) options.arcGorillaPoolUrl = undefined
  if (process.env.WALLET_STORAGE_GORILLAPOOL_ARC_URL) {
    options.arcGorillaPoolUrl = process.env.WALLET_STORAGE_GORILLAPOOL_ARC_URL
  }
  if (providerConfig.arcadeUrl) {
    options.arcadeUrl = providerConfig.arcadeUrl
    options.arcadeConfig = {
      apiKey: providerConfig.arcadeApiKey || undefined,
      callbackToken: providerConfig.arcadeCallbackToken || undefined
    }
  }
  return options
}

async function createServicesAndMonitorOptions(
  chain: WalletChain,
  knex: Knex,
  storage: WalletStorageManager
) {
  const startupTaskMode = readMonitorStartupTaskMode()
  if (chain === 'mock') {
    const services = new MockServices(knex)
    await services.initialize()
    return {
      services,
      monitorOptions: {
        chain,
        services,
        storage,
        chaintracks: services.tracker,
        msecsWaitPerMerkleProofServiceReq: 500,
        taskRunWaitMsecs: 5000,
        abandonedMsecs: 1000 * 60 * 5,
        unprovenAttemptsLimitTest: 10,
        unprovenAttemptsLimitMain: 144,
        maxRebroadcastAttempts: 0,
        startupTaskMode
      }
    }
  }
  const services = new Services(configuredServiceOptions(chain))
  const monitorOptions = Monitor.createDefaultWalletMonitorOptions(
    chain,
    storage,
    services,
    undefined,
    startupTaskMode
  )
  if (providerConfig.arcadeUrl && providerConfig.arcadeCallbackToken) {
    monitorOptions.callbackToken = providerConfig.arcadeCallbackToken
    monitorOptions.EventSourceClass = EventSource
  }
  return { services, monitorOptions }
}

function walletNetworkPreset(
  chain: WalletChain
): 'local' | 'mainnet' | 'testnet' {
  if (chain === 'main') return 'mainnet'
  if (chain === 'test') return 'testnet'
  return 'local'
}

function createWalletLoggerFactory() {
  const loggerLevel = readWalletLoggerLevel()
  if (loggerLevel == null) return undefined
  return (source?: string | import('@bsv/sdk').WalletLoggerInterface) => {
    const logger = new WalletLogger(source)
    logger.level = loggerLevel
    logger.flushFormat = 'json' as const
    return logger
  }
}

const providerConfig = {
  taalApiKey: process.env.WALLET_STORAGE_TAAL_API_KEY ?? TAAL_API_KEY,
  whatsOnChainApiKey:
    process.env.WALLET_STORAGE_WHATSONCHAIN_API_KEY ?? WHATSONCHAIN_API_KEY,
  bitailsApiKey: process.env.WALLET_STORAGE_BITAILS_API_KEY ?? BITAILS_API_KEY,
  arcadeUrl: process.env.WALLET_STORAGE_ARCADE_URL ?? ARCADE_URL,
  arcadeApiKey: process.env.WALLET_STORAGE_ARCADE_API_KEY ?? ARCADE_API_KEY,
  arcadeCallbackToken:
    process.env.WALLET_STORAGE_ARCADE_CALLBACK_TOKEN ?? ARCADE_CALLBACK_TOKEN,
  exchangeRatesApiKey:
    process.env.WALLET_STORAGE_EXCHANGE_RATES_API_KEY ?? EXCHANGERATESAPI_KEY
}

interface WalletRuntimeContext {
  chain: WalletChain
  databaseName: string
  knex: Knex
  activeStorage: StorageKnex
  storage: WalletStorageManager
  services: Services | MockServices
  settings: TableSettings
  keyDeriver: WalletKeyDeriver
  wallet: Wallet
  server: StorageServer
  monitor: Monitor
}

function createMonitorAdmin(
  config: MonitorAdminConfig,
  context: WalletRuntimeContext
): { server: AdminServer; authWallet: Wallet } {
  const rootKey = PrivateKey.fromHex(config.privateKey)
  const keyDeriver = new KeyDeriver(rootKey)
  const authWallet = new Wallet({
    chain: context.chain,
    keyDeriver,
    storage: new WalletStorageManager(rootKey.toPublicKey().toString()),
    services: context.services
  })
  const daemon = new MonitorDaemon({
    chain: context.chain,
    storageProvider: context.activeStorage,
    storageManager: context.storage,
    services:
      context.services instanceof Services ? context.services : undefined,
    monitor: context.monitor
  })
  daemon.setup = daemon.args

  return {
    server: new AdminServer({
      config: {
        chain: context.chain,
        adminHost: config.host,
        adminPort: config.port,
        adminIdentityKeys: config.identityKeys,
        adminAllowedOrigins: config.allowedOrigins
      },
      daemon,
      authWallet
    }),
    authWallet
  }
}

async function setupWalletStorageAndMonitor(): Promise<WalletRuntimeContext> {
  try {
    if (!SERVER_PRIVATE_KEY) {
      throw new Error('SERVER_PRIVATE_KEY must be set')
    }
    if (!KNEX_DB_CONNECTION) {
      throw new Error('KNEX_DB_CONNECTION must be set')
    }

    const numCommissionFee = Number(COMMISSION_FEE)
    const commissionSatoshis = Number.isInteger(numCommissionFee)
      ? numCommissionFee
      : 0

    if (commissionSatoshis > 0 && !COMMISSION_PUBLIC_KEY) {
      throw new Error(
        'COMMISSION_PUBLIC_KEY must be set when COMMISSION_FEE is greater than zero'
      )
    }
    // Parse database connection details
    const connection = JSON.parse(
      decodeJsonSetting('KNEX_DB_CONNECTION', KNEX_DB_CONNECTION)
    )
    const databaseName = connection['database']

    // You can also use an imported knex configuration file.
    const knexConfig: Knex.Config = {
      client: 'mysql2',
      connection,
      useNullAsDefault: true,
      pool: {
        min: readNonNegativeInteger('WALLET_STORAGE_DB_POOL_MIN', 2),
        max: readPositiveInteger('WALLET_STORAGE_DB_POOL_MAX', 10),
        createTimeoutMillis: readPositiveInteger(
          'WALLET_STORAGE_DB_CREATE_TIMEOUT_MS',
          10_000
        ),
        acquireTimeoutMillis: readPositiveInteger(
          'WALLET_STORAGE_DB_ACQUIRE_TIMEOUT_MS',
          30_000
        ),
        idleTimeoutMillis: readPositiveInteger(
          'WALLET_STORAGE_DB_IDLE_TIMEOUT_MS',
          600_000
        ),
        reapIntervalMillis: readPositiveInteger(
          'WALLET_STORAGE_DB_REAP_INTERVAL_MS',
          60_000
        ),
        createRetryIntervalMillis: readPositiveInteger(
          'WALLET_STORAGE_DB_CREATE_RETRY_MS',
          200
        ),
        propagateCreateError: false
      }
    }
    if ((knexConfig.pool?.min ?? 0) > (knexConfig.pool?.max ?? 0)) {
      throw new Error(
        'WALLET_STORAGE_DB_POOL_MIN must not exceed WALLET_STORAGE_DB_POOL_MAX'
      )
    }
    const knex = makeKnex(knexConfig)

    const chain = readWalletChain()

    // Initialize storage components
    const rootKey = PrivateKey.fromHex(SERVER_PRIVATE_KEY)
    const storageIdentityKey = rootKey.toPublicKey().toString()

    const activeStorage = new StorageKnex({
      chain,
      knex,
      commissionSatoshis,
      commissionPubKeyHex: COMMISSION_PUBLIC_KEY || undefined,
      feeModel: JSON.parse(decodeJsonSetting('FEE_MODEL', String(FEE_MODEL)))
    })

    await activeStorage.migrate(databaseName, storageIdentityKey)
    const settings = await activeStorage.makeAvailable()

    const storage = new WalletStorageManager(
      settings.storageIdentityKey,
      activeStorage
    )
    await storage.makeAvailable()

    const { services, monitorOptions } = await createServicesAndMonitorOptions(
      chain,
      knex,
      storage
    )
    const keyDeriver = new KeyDeriver(rootKey)

    const monitor = new Monitor(monitorOptions)

    const wallet = new Wallet({
      chain,
      keyDeriver,
      storage,
      services,
      monitor,
      lookupResolver: new LookupResolver({
        networkPreset: walletNetworkPreset(chain)
      })
    })

    const makeLogger = createWalletLoggerFactory()

    // Set up server options
    const serverOptions: WalletStorageServerOptions & {
      host: string
      paymentReplayStore: KnexPaymentReplayStore
    } = {
      host: readStorageBindHost(),
      port: Number(HTTP_PORT),
      wallet,
      monetize: readBoolean('WALLET_STORAGE_MONETIZATION_ENABLED', false),
      calculateRequestPrice: () =>
        readNonNegativeInteger('WALLET_STORAGE_PRICE_SATOSHIS', 100),
      adminIdentityKeys: readAdminIdentityKeys(),
      trustProxy: readOptionalProxyHops(),
      makeLogger,
      sessionManager: new KnexSessionManager(knex, {
        ttlMs: readPositiveInteger(
          'WALLET_STORAGE_AUTH_SESSION_TTL_MS',
          24 * 60 * 60 * 1_000
        )
      }),
      paymentReplayStore: new KnexPaymentReplayStore(
        knex,
        process.env.WALLET_STORAGE_PAYMENT_REPLAY_TTL_DAYS === '-1'
          ? -1
          : readPositiveInteger('WALLET_STORAGE_PAYMENT_REPLAY_TTL_DAYS', 365)
      ),
      logRpcRequests: readBoolean('WALLET_STORAGE_LOG_RPC_REQUESTS', true)
    }
    const server = new StorageServer(activeStorage, serverOptions)

    return {
      chain,
      databaseName,
      knex,
      activeStorage,
      storage,
      services,
      settings,
      keyDeriver,
      wallet,
      server,
      monitor
    }
  } catch (error) {
    log.error(
      { operation: 'wallet_storage.setup', outcome: 'error', err: error },
      'Error setting up wallet storage and monitor'
    )
    throw error
  }
}

// Start the server. Wrap startup in a span so a slow/failed boot is visible in
// traces, and emit structured timed events.
await tracer.startActiveSpan('wallet-infra.bootstrap', async span => {
  const startedAt = Date.now()
  try {
    const role = readRole()
    const monitorAdminConfig = readMonitorAdminConfig(role)
    const monitorTasksEnabled = role !== 'api' && readMonitorTasksEnabled()
    const walletToolboxVersion = String(
      packageJson.dependencies['@bsv/wallet-toolbox']
    ).replace(/^[~^]/, '')
    const context = await setupWalletStorageAndMonitor()
    log.info(
      {
        operation: 'storage.setup',
        wallet_toolbox_version: walletToolboxVersion,
        network: BSV_NETWORK,
        monitor_tasks_enabled: monitorTasksEnabled,
        monitor_startup_task_mode: context.monitor.options.startupTaskMode,
        monitor_admin_enabled: monitorAdminConfig != null
      },
      'wallet storage and monitor configured'
    )
    log.debug(
      { operation: 'storage.setup', settings: context.settings },
      'storage settings'
    )

    if (role !== 'monitor') {
      context.server.start()
      log.info(
        { operation: 'storage_server.start', outcome: 'ok' },
        'StorageServer started'
      )
    }

    if (monitorTasksEnabled) {
      await context.monitor.startTasks()
      log.info({ operation: 'monitor.start', outcome: 'ok' }, 'Monitor started')
    }

    let monitorAdmin: ReturnType<typeof createMonitorAdmin> | undefined
    if (monitorAdminConfig != null) {
      monitorAdmin = createMonitorAdmin(monitorAdminConfig, context)
      monitorAdmin.server.start()
      log.info(
        {
          operation: 'monitor_admin.start',
          outcome: 'ok',
          host: monitorAdminConfig.host,
          port: monitorAdminConfig.port
        },
        'Monitor admin started'
      )
    }

    // Conditionally start nginx
    let nginxProcess: ChildProcess | undefined
    if (role !== 'monitor' && ENABLE_NGINX === 'true') {
      nginxProcess = spawn('/usr/sbin/nginx', [], {
        stdio: ['inherit', 'inherit', 'inherit']
      })
      log.info({ operation: 'nginx.spawn', outcome: 'ok' }, 'nginx started')
    }

    const shutdown = (signal: NodeJS.Signals): Promise<void> => {
      shutdownPromise ??= (async () => {
        log.info(
          { operation: 'shutdown', signal },
          'wallet-infra shutdown started'
        )
        if (monitorTasksEnabled) context.monitor.stopTasks()
        if (monitorAdmin != null) {
          await monitorAdmin.server.close()
          await monitorAdmin.authWallet.destroy()
        }
        nginxProcess?.kill('SIGTERM')
        if (role !== 'monitor' && context.server.server != null) {
          await closeHttpServer(context.server.server as Server)
        }
        await context.wallet.destroy()
        log.info(
          { operation: 'shutdown', outcome: 'ok', signal },
          'wallet-infra shutdown complete'
        )
      })().catch(error => {
        process.exitCode = 1
        log.error(
          { operation: 'shutdown', outcome: 'error', signal, err: error },
          'wallet-infra shutdown failed'
        )
      })
      return shutdownPromise
    }
    process.once('SIGTERM', () => void shutdown('SIGTERM'))
    process.once('SIGINT', () => void shutdown('SIGINT'))

    const duration_ms = Date.now() - startedAt
    span.setAttribute('bsv.network', String(BSV_NETWORK))
    span.setAttribute('nginx.enabled', ENABLE_NGINX === 'true')
    span.setAttribute('wallet.infra.role', role)
    span.setStatus({ code: SpanStatusCode.OK })
    log.info(
      { operation: 'bootstrap', outcome: 'ok', duration_ms },
      'wallet-infra started'
    )
  } catch (error) {
    const duration_ms = Date.now() - startedAt
    span.recordException(error as Error)
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message
    })
    log.error(
      { operation: 'bootstrap', outcome: 'error', duration_ms, err: error },
      'wallet-infra failed to start'
    )
    process.exitCode = 1
  } finally {
    span.end()
  }
})
