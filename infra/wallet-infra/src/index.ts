import { PrivateKey, KeyDeriver, LookupResolver } from '@bsv/sdk'
import {
  Services,
  MockServices,
  StorageKnex,
  TableSettings,
  WalletStorageManager,
  WalletStorageServerOptions,
  StorageServer,
  Wallet,
  Monitor
} from '@bsv/wallet-toolbox'
import knexPkg from 'knex'
const { knex: makeKnex } = knexPkg
import type { Knex } from 'knex'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'
import packageJson from '../package.json' with { type: 'json' }
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { log } from './logger.js'

import * as dotenv from 'dotenv'
dotenv.config()

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
  BSV_NETWORK = 'main',
  ENABLE_NGINX = 'true',
  HTTP_PORT = 8081, // Must be 8081 if ENABLE_NGINX 'true',
  SERVER_PRIVATE_KEY,
  KNEX_DB_CONNECTION,
  TAAL_API_KEY,
  COMMISSION_FEE = 0,
  COMMISSION_PUBLIC_KEY,
  FEE_MODEL = '{"model":"sat/kb","value":1}'
} = process.env

async function setupWalletStorageAndMonitor(): Promise<{
  databaseName: string
  knex: Knex
  activeStorage: StorageKnex
  storage: WalletStorageManager
  services: Services | MockServices
  settings: TableSettings
  keyDeriver: KeyDeriver
  wallet: Wallet
  server: StorageServer
  monitor: Monitor
}> {
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
    const connection = JSON.parse(KNEX_DB_CONNECTION)
    const databaseName = connection['database']

    // You can also use an imported knex configuration file.
    const knexConfig: Knex.Config = {
      client: 'mysql2',
      connection,
      useNullAsDefault: true,
      pool: {
        min: 2,
        max: 10,
        createTimeoutMillis: 10000,
        acquireTimeoutMillis: 30000,
        idleTimeoutMillis: 600000,
        reapIntervalMillis: 60000,
        createRetryIntervalMillis: 200,
        propagateCreateError: false
      }
    }
    const knex = makeKnex(knexConfig)

    // Select chain from BSV_NETWORK: "main", "test", "ttn" (TeraTestNet),
    // "tstn" (Teranode Scaling Test Net), or "mock" (defaults to "main")
    const allowedChains = ['main', 'test', 'ttn', 'tstn', 'mock'] as const
    let chain: (typeof allowedChains)[number] = 'main'
    if (
      typeof BSV_NETWORK === 'string' &&
      allowedChains.includes(BSV_NETWORK as any)
    ) {
      chain = BSV_NETWORK as (typeof allowedChains)[number]
    } else if (BSV_NETWORK !== 'main') {
      log.warn(
        {
          operation: 'chain.select',
          bsv_network: BSV_NETWORK,
          fallback_chain: 'main'
        },
        'Invalid BSV_NETWORK value provided, falling back to main'
      )
    }

    // Initialize storage components
    const rootKey = PrivateKey.fromHex(SERVER_PRIVATE_KEY)
    const storageIdentityKey = rootKey.toPublicKey().toString()

    const activeStorage = new StorageKnex({
      chain,
      knex,
      commissionSatoshis,
      commissionPubKeyHex: COMMISSION_PUBLIC_KEY || undefined,
      feeModel: JSON.parse(FEE_MODEL)
    })

    await activeStorage.migrate(databaseName, storageIdentityKey)
    const settings = await activeStorage.makeAvailable()

    const storage = new WalletStorageManager(
      settings.storageIdentityKey,
      activeStorage
    )
    await storage.makeAvailable()

    // Initialize wallet components
    let services
    let monopts
    if (chain === 'mock') {
      services = new MockServices(knex)
      await services.initialize()
      monopts = {
        chain,
        services,
        storage,
        chaintracks: services.tracker,
        msecsWaitPerMerkleProofServiceReq: 500,
        taskRunWaitMsecs: 5000,
        abandonedMsecs: 1000 * 60 * 5,
        unprovenAttemptsLimitTest: 10,
        unprovenAttemptsLimitMain: 144,
        maxRebroadcastAttempts: 0
      }
    } else {
      const servOpts = Services.createDefaultOptions(chain)
      if (TAAL_API_KEY) {
        servOpts.arcConfig.apiKey = TAAL_API_KEY
        servOpts.taalApiKey = TAAL_API_KEY
      }
      services = new Services(servOpts)
      monopts = Monitor.createDefaultWalletMonitorOptions(
        chain,
        storage,
        services
      )
    }
    const keyDeriver = new KeyDeriver(rootKey)

    const monitor = new Monitor(monopts)
    monitor.addDefaultTasks()

    let networkPresetForLookupResolver: 'local' | 'mainnet' | 'testnet' =
      'local'
    switch (chain) {
      case 'main':
        networkPresetForLookupResolver = 'mainnet'
        break
      case 'test':
        networkPresetForLookupResolver = 'testnet'
        break
      default:
        break
    }
    const wallet = new Wallet({
      chain,
      keyDeriver,
      storage,
      services,
      monitor,
      lookupResolver: new LookupResolver({
        networkPreset: networkPresetForLookupResolver
      })
    })

    // Set up server options
    const serverOptions: WalletStorageServerOptions = {
      port: Number(HTTP_PORT),
      wallet,
      monetize: false,
      calculateRequestPrice: async () => {
        return 0 // Monetize your server here! Price is in satoshis.
      }
    }
    const server = new StorageServer(activeStorage, serverOptions)

    return {
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
    const walletToolboxVersion = String(
      packageJson.dependencies['@bsv/wallet-toolbox']
    ).replace(/^[~^]/, '')
    const context = await setupWalletStorageAndMonitor()
    log.info(
      {
        operation: 'storage.setup',
        wallet_toolbox_version: walletToolboxVersion,
        network: BSV_NETWORK
      },
      'wallet storage and monitor configured'
    )
    log.debug(
      { operation: 'storage.setup', settings: context.settings },
      'storage settings'
    )

    context.server.start()
    log.info(
      { operation: 'storage_server.start', outcome: 'ok' },
      'StorageServer started'
    )

    await context.monitor.startTasks()
    log.info({ operation: 'monitor.start', outcome: 'ok' }, 'Monitor started')

    // Conditionally start nginx
    let nginxProcess: ChildProcess | undefined
    if (ENABLE_NGINX === 'true') {
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
        context.monitor.stopTasks()
        nginxProcess?.kill('SIGTERM')
        await closeHttpServer(context.server.server as Server)
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
