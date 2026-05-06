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
  COMMISSION_FEE = 0,
  COMMISSION_PUBLIC_KEY,
  FEE_MODEL = '{"model":"sat/kb","value":1}'
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
