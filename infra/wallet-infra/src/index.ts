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
  Monitor,
  runSchemaCutover,
  backfillLegacyOnlySync
} from '@bsv/wallet-toolbox'
import knexPkg from 'knex'
const { knex: makeKnex } = knexPkg
import type { Knex } from 'knex'
import { spawn } from 'node:child_process'
import packageJson from '../package.json' with { type: 'json' }

import * as dotenv from 'dotenv'
dotenv.config()

// Load environment variables
const {
  BSV_NETWORK = 'test',
  ENABLE_NGINX = 'true',
  HTTP_PORT = 8081, // Must be 8081 if ENABLE_NGINX 'true',
  SERVER_PRIVATE_KEY,
  KNEX_DB_CONNECTION,
  TAAL_API_KEY,
  ARC_URL,
  ARC_API_KEY,
  ARC_CALLBACK_TOKEN,
  COMMISSION_FEE = 0,
  COMMISSION_PUBLIC_KEY,
  FEE_MODEL = '{"model":"sat/kb","value":1}',
  LEGACY_UPGRADE = 'false'
} = process.env

async function setupWalletStorageAndMonitor(): Promise<{
  databaseName: string
  knex: Knex
  activeStorage: StorageKnex
  storage: WalletStorageManager
  services: Services
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

    /*
     * Knex client selection. Defaults to mysql2 to preserve existing
     * deployments. Operators can pick Postgres at deploy time by setting
     * `KNEX_DB_CLIENT=pg`, or by including `"client": "pg"` inside the
     * `KNEX_DB_CONNECTION` JSON. Aliases ('mysql', 'mysql2', 'postgres',
     * 'postgresql') are normalised to the canonical Knex client name.
     */
    const rawClient: string = String(
      process.env.KNEX_DB_CLIENT ?? connection.client ?? 'mysql2'
    ).toLowerCase()
    delete connection.client
    let client: 'mysql2' | 'pg'
    if (
      rawClient === 'pg' ||
      rawClient === 'postgres' ||
      rawClient === 'postgresql'
    ) {
      client = 'pg'
    } else if (rawClient === 'mysql' || rawClient === 'mysql2') {
      client = 'mysql2'
    } else {
      throw new Error(
        `Unsupported KNEX_DB_CLIENT '${rawClient}'. Use 'mysql2' or 'pg'.`
      )
    }

    // Pool sizing: defaults sized for a single Cloud Run revision with 1–2
    // vCPU and bursty traffic. `KNEX_POOL_MAX` / `KNEX_POOL_MIN` allow
    // operators to tune at deploy time without rebuilding. `acquireTimeoutMs`
    // intentionally short to fail-fast on pool exhaustion so callers can
    // back off rather than queue indefinitely.
    const poolMax = Number(process.env.KNEX_POOL_MAX ?? 32)
    const poolMin = Number(process.env.KNEX_POOL_MIN ?? 2)

    // Client-specific connection options. Pg defaults are minimal — the node-
    // postgres driver does most of the right things out of the box (Buffer ↔
    // bytea, dates parsed into Date). mysql2 needs explicit number / date /
    // statement-cache tuning to match.
    const connectionOptions =
      client === 'mysql2'
        ? {
            ...connection,
            decimalNumbers: true,
            dateStrings: false,
            supportBigNumbers: true,
            bigNumberStrings: false,
            // Per-connection prepared-statement cache. Cap at 256 (~4× the
            // wallet's hot query set).
            maxPreparedStatements: 256
          }
        : { ...connection }

    const knexConfig: Knex.Config = {
      client,
      connection: connectionOptions,
      useNullAsDefault: true,
      pool: {
        min: poolMin,
        max: poolMax,
        createTimeoutMillis: 10000,
        acquireTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        reapIntervalMillis: 1000,
        createRetryIntervalMillis: 200,
        propagateCreateError: false
      },
      // Knex acquireConnectionTimeout governs pool waits separately from
      // tarn's acquireTimeoutMillis. Keep them aligned.
      acquireConnectionTimeout: 5000
    }
    const knex = makeKnex(knexConfig)

    // Select chain from BSV_NETWORK: "main", "test", "teratest", or "mock" (defaults to "test")
    const allowedChains = ['main', 'test', 'teratest', 'mock'] as const
    let chain: (typeof allowedChains)[number] = 'test'
    if (
      typeof BSV_NETWORK === 'string' &&
      allowedChains.includes(BSV_NETWORK as any)
    ) {
      chain = BSV_NETWORK as (typeof allowedChains)[number]
    } else if (BSV_NETWORK !== 'test') {
      console.warn(
        `Invalid BSV_NETWORK value "${BSV_NETWORK}" provided. Falling back to "test".`
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

    // v3 is the canonical target schema. Auto-detect install posture and
    // act accordingly:
    //   - Fresh install (no legacy data, no `transactions_legacy` yet):
    //     run runSchemaCutover() silently as part of initialization. End
    //     state is v3 with empty legacy tables.
    //   - Post-cutover (`transactions_legacy` already exists): no-op.
    //   - Upgrade from v2 (legacy `transactions` rows exist + no
    //     `transactions_legacy`): refuse boot unless LEGACY_UPGRADE=true.
    //     Cutover on populated production data is destructive and must be
    //     an explicit operator decision after backup + read-runbook.
    const hasLegacyMarker = await knex.schema.hasTable('transactions_legacy')
    if (!hasLegacyMarker) {
      const legacyCount = await knex('transactions')
        .count<{ c: number }>({ c: '*' })
        .first()
      const legacyRows = Number(legacyCount?.c ?? 0)
      if (legacyRows === 0) {
        console.log('Fresh install detected — initializing v3 schema…')
        await runSchemaCutover(knex)
        console.log('v3 schema ready.')
      } else if (LEGACY_UPGRADE === 'true') {
        console.log(
          `LEGACY_UPGRADE=true → migrating ${legacyRows} legacy transaction rows to v3 schema…`
        )
        await runSchemaCutover(knex)
        console.log('Schema cutover complete.')
      } else {
        throw new Error(
          `Legacy v2 data detected (${legacyRows} rows in transactions, no transactions_legacy marker). ` +
            'Refusing to start without explicit upgrade authorization. ' +
            'Backup the database, then either set LEGACY_UPGRADE=true and restart, ' +
            'or run `npm run cutover` during a maintenance window and restart this process. ' +
            'See @bsv/wallet-toolbox docs/CUTOVER_RUNBOOK.md before proceeding.'
        )
      }
    }

    // Bridge any rows that the sync path wrote into `transactions_legacy`
    // before the canonical-table bridge in `StorageKnex.insertTransaction`
    // landed. Idempotent and cheap (one indexed left-join) on clean DBs.
    const bridge = await backfillLegacyOnlySync(knex)
    if (bridge.migratedTransactions > 0) {
      console.log(
        `Sync-bridge backfill: migrated ${bridge.migratedTransactions} legacy-only transactions, ` +
          `remapped ${bridge.remappedOutputs} outputs and ${bridge.remappedCommissions} commissions to canonical ids.`
      )
    }

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
        unprovenAttemptsLimitMain: 144
      }
    } else {
      const servOpts = Services.createDefaultOptions(chain)
      if (TAAL_API_KEY) {
        servOpts.arcConfig.apiKey = TAAL_API_KEY
        servOpts.taalApiKey = TAAL_API_KEY
      }
      if (ARC_URL) {
        servOpts.arcUrl = ARC_URL
      }
      if (ARC_API_KEY) {
        servOpts.arcConfig.apiKey = ARC_API_KEY
      }
      services = new Services(servOpts)
      monopts = Monitor.createDefaultWalletMonitorOptions(
        chain,
        storage,
        services
      )
      if (ARC_CALLBACK_TOKEN) {
        monopts.callbackToken = ARC_CALLBACK_TOKEN
      }
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
    console.error('Error setting up Wallet Storage and Monitor:', error)
    throw error
  }
}

// Start the server
try {
  const context = await setupWalletStorageAndMonitor()
  console.log(
    'wallet-toolbox v' +
      String(packageJson.dependencies['@bsv/wallet-toolbox']).replace(
        /^[~^]/,
        ''
      )
  )
  console.log(JSON.stringify(context.settings, null, 2))

  context.server.start()
  console.log('wallet-toolbox StorageServer started')

  await context.monitor.startTasks()
  console.log('wallet-toolbox Monitor started')

  // Conditionally start nginx
  if (ENABLE_NGINX === 'true') {
    console.log('Spawning nginx...')
    spawn('/usr/sbin/nginx', [], { stdio: ['inherit', 'inherit', 'inherit'] })
    console.log('nginx is up!')
  }
} catch (error) {
  console.error('Error starting server:', error)
}
