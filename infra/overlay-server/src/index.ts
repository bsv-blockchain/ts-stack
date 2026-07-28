import { WalletAdvertiser } from '@bsv/overlay-discovery-services'
import OverlayExpress from '@bsv/overlay-express'
import {
  ProtoMapTopicManager,
  createProtoMapLookupService,
  CertMapTopicManager,
  createCertMapLookupService,
  BasketMapTopicManager,
  createBasketMapLookupService,
  UHRPTopicManager,
  createUHRPLookupService,
  IdentityTopicManager,
  createIdentityLookupService,
  MessageBoxTopicManager,
  createMessageBoxLookupService,
  UMPTopicManager,
  createUMPLookupService,
  HelloWorldTopicManager,
  createHelloWorldLookupService,
  SlackThreadsTopicManager,
  createSlackThreadsLookupService,
  DesktopIntegrityTopicManager,
  createDesktopIntegrityLookupService,
  FractionalizeTopicManager,
  createFractionalizeLookupService,
  SupplyChainTopicManager,
  createSupplyChainLookupService,
  MonsterBattleTopicManager,
  createMonsterBattleLookupService,
  AnyTopicManager,
  createAnyLookupService,
  AppsTopicManager,
  createAppsLookupService,
  DIDTopicManager,
  createDIDLookupService,
  WalletConfigTopicManager,
  createWalletConfigLookupService,
  TokenDemoTopicManager,
  createTokenDemoLookupService,
  MandalaTopicManager,
  MandalaStorageManager,
  createMandalaLookupService,
  InMemoryScreeningProvider
} from '@bsv/overlay-topics'
import { PrivateKey, ProtoWallet, WalletInterface } from '@bsv/sdk'

import { config } from 'dotenv'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import packageJson from '../package.json' with { type: 'json' }
import { log } from './logger.js'
config()

const tracer = trace.getTracer(packageJson.name, packageJson.version)

// Reads a required environment variable, failing fast with a clear message if it is missing.
const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new TypeError(`Missing required environment variable: ${name}`)
  }
  return value
}

const optionalEnv = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

const optionalSecretEnv = (name: string, minimumLength: number): string | undefined => {
  const value = optionalEnv(name)
  if (value !== undefined && value.length < minimumLength) {
    throw new TypeError(`${name} must contain at least ${minimumLength} characters`)
  }
  return value
}

const boolEnv = (name: string, defaultValue: boolean): boolean => {
  const value = optionalEnv(name)
  if (value === undefined) return defaultValue
  return value === 'true' || value === '1' || value === 'yes'
}

const numberEnv = (name: string): number | undefined => {
  const value = optionalEnv(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${name} must be a finite number, got: ${value}`)
  }
  return parsed
}

const networkEnv = (): 'main' | 'test' => {
  const network = requireEnv('NETWORK')
  if (network !== 'main' && network !== 'test') {
    throw new TypeError(`NETWORK must be "main" or "test", got: ${network}`)
  }
  return network
}

const requirePropagationProvider = (
  arcApiKey: string | undefined,
  arcadeUrl: string | undefined
): void => {
  if (arcApiKey === undefined && arcadeUrl === undefined) {
    throw new TypeError(
      'Configure at least one transaction propagation provider: ARC_API_KEY or ARCADE_URL'
    )
  }
}

const overlayLogArgs = (args: unknown[]): { message: string; fields: Record<string, unknown> } => {
  const [first, ...rest] = args
  if (typeof first === 'string') {
    return {
      message: first,
      fields: rest.length > 0 ? { operation: 'overlay', args: rest } : { operation: 'overlay' }
    }
  }
  return {
    message: 'overlay log',
    fields: {
      operation: 'overlay',
      event: first,
      args: rest
    }
  }
}

const overlayLogger = {
  log: (...args: unknown[]) => {
    const entry = overlayLogArgs(args)
    log.info(entry.fields, entry.message)
  },
  info: (...args: unknown[]) => {
    const entry = overlayLogArgs(args)
    log.info(entry.fields, entry.message)
  },
  warn: (...args: unknown[]) => {
    const entry = overlayLogArgs(args)
    log.warn(entry.fields, entry.message)
  },
  error: (...args: unknown[]) => {
    const entry = overlayLogArgs(args)
    log.error(entry.fields, entry.message)
  },
  debug: (...args: unknown[]) => {
    const entry = overlayLogArgs(args)
    log.debug(entry.fields, entry.message)
  }
}

type OverlayProviderConfigMethods = OverlayExpress & {
  configureArcade?: (
    url: string,
    config?: {
      apiKey?: string
      deploymentId?: string
      chaintracksApiPrefix?: string
    }
  ) => void
  configureChaintracks?: (
    url: string,
    config?: {
      apiPrefix?: string
      reorgStream?: boolean
      scanDepth?: number
    }
  ) => void
  configureUnprovenMaintenance?: (config: { intervalMs?: number; thresholdBlocks?: number }) => void
}

// Hi there! Let's configure Overlay Express!
const main = async () => {
  // Validate required configuration up front so misconfiguration fails fast.
  const NODE_NAME = requireEnv('NODE_NAME')
  const SERVER_PRIVATE_KEY = requireEnv('SERVER_PRIVATE_KEY')
  const HOSTING_URL = requireEnv('HOSTING_URL')
  const WALLET_STORAGE_URL = requireEnv('WALLET_STORAGE_URL')
  const ARC_API_KEY = optionalEnv('ARC_API_KEY')
  const ARC_CALLBACK_TOKEN = optionalEnv('ARC_CALLBACK_TOKEN')
  const ARCADE_URL = optionalEnv('ARCADE_URL')
  const ARCADE_API_KEY = optionalEnv('ARCADE_API_KEY')
  const ARCADE_DEPLOYMENT_ID = optionalEnv('ARCADE_DEPLOYMENT_ID')
  const CHAINTRACKS_URL = optionalEnv('CHAINTRACKS_URL')
  const CHAINTRACKS_API_PREFIX = optionalEnv('CHAINTRACKS_API_PREFIX') ?? '/chaintracks/v2'
  const KNEX_URL = requireEnv('KNEX_URL')
  const MONGO_URL = requireEnv('MONGO_URL')
  const ADMIN_TOKEN = optionalSecretEnv('ADMIN_TOKEN', 32) // random token generated if unset

  const NETWORK = networkEnv()
  requirePropagationProvider(ARC_API_KEY, ARCADE_URL)

  // We'll make a new server for our overlay node.
  const server = new OverlayExpress(
    // Name your overlay node with a one-word lowercase string
    NODE_NAME,

    // Provide the private key that gives your node its identity
    SERVER_PRIVATE_KEY,

    // Provide the HTTPS URL where your node is available on the internet
    HOSTING_URL,

    // Provide an adminToken to enable the admin API
    ADMIN_TOKEN
  )
  const providerServer = server as OverlayProviderConfigMethods
  server.configureLogger(overlayLogger as unknown as typeof console)

  const wa = new WalletAdvertiser(NETWORK, SERVER_PRIVATE_KEY, WALLET_STORAGE_URL, HOSTING_URL)

  await wa.init()

  server.configureEngineParams({
    advertiser: wa,
    throwOnBroadcastFailure: boolEnv('THROW_ON_BROADCAST_FAIL', true)
  })

  server.configureNetwork(NETWORK)

  if (ARC_CALLBACK_TOKEN !== undefined) {
    server.configureArcCallbackToken(ARC_CALLBACK_TOKEN)
  }

  if (ARCADE_URL !== undefined) {
    if (typeof providerServer.configureArcade !== 'function') {
      throw new TypeError(
        'ARCADE_URL requires an @bsv/overlay-express version with configureArcade support'
      )
    }
    providerServer.configureArcade(ARCADE_URL, {
      apiKey: ARCADE_API_KEY,
      deploymentId: ARCADE_DEPLOYMENT_ID,
      chaintracksApiPrefix: CHAINTRACKS_API_PREFIX
    })
  }

  if (ARC_API_KEY !== undefined) {
    server.configureArcApiKey(ARC_API_KEY)
  }

  const chaintracksUrl =
    CHAINTRACKS_URL ??
    (boolEnv('USE_ARCADE_CHAINTRACKS', ARCADE_URL !== undefined) ? ARCADE_URL : undefined)
  if (chaintracksUrl !== undefined) {
    if (typeof providerServer.configureChaintracks !== 'function') {
      throw new TypeError(
        'CHAINTRACKS_URL/USE_ARCADE_CHAINTRACKS requires an @bsv/overlay-express version with configureChaintracks support'
      )
    }
    providerServer.configureChaintracks(chaintracksUrl, {
      apiPrefix: CHAINTRACKS_API_PREFIX,
      reorgStream: boolEnv('BASM_REORG_STREAM_ENABLED', true),
      scanDepth: numberEnv('BASM_REORG_SCAN_DEPTH')
    })
  }

  server.configureEnableBASMSync(boolEnv('BASM_ENABLED', false))
  const basmBlockPollIntervalMs = numberEnv('BASM_BLOCK_POLL_INTERVAL_MS')
  if (basmBlockPollIntervalMs !== undefined) {
    server.configureBASMBlockPollInterval(basmBlockPollIntervalMs)
  }
  const unprovenMaintenanceIntervalMs = numberEnv('UNPROVEN_MAINTENANCE_INTERVAL_MS') ?? 0
  const unprovenEvictionBlocks = numberEnv('UNPROVEN_EVICTION_BLOCKS')
  if (unprovenMaintenanceIntervalMs > 0 || unprovenEvictionBlocks !== undefined) {
    if (typeof providerServer.configureUnprovenMaintenance !== 'function') {
      throw new TypeError(
        'Unproven maintenance configuration requires an @bsv/overlay-express version with configureUnprovenMaintenance support'
      )
    }
    providerServer.configureUnprovenMaintenance({
      intervalMs: unprovenMaintenanceIntervalMs,
      thresholdBlocks: unprovenEvictionBlocks
    })
  }

  server.configureHealth({
    contextProvider: () => ({
      providers: {
        arc: ARC_API_KEY !== undefined,
        arcade: ARCADE_URL !== undefined,
        chaintracks: chaintracksUrl !== undefined
      },
      broadcast: {
        throwOnBroadcastFailure: boolEnv('THROW_ON_BROADCAST_FAIL', true)
      },
      basm: {
        enabled: boolEnv('BASM_ENABLED', false),
        reorgStreamEnabled: boolEnv('BASM_REORG_STREAM_ENABLED', true),
        blockPollIntervalMs: basmBlockPollIntervalMs,
        unprovenMaintenanceIntervalMs,
        unprovenEvictionBlocks
      }
    })
  })

  // Decide what port you want the server to listen on.
  server.configurePort(8080)

  // Connect to your SQL database with Knex
  await server.configureKnex(KNEX_URL)

  // Also, be sure to connect to MongoDB
  await server.configureMongo(MONGO_URL)

  // Here, you will configure the overlay topic managers and lookup services you want.
  // - Topic managers decide what outputs can go in your overlay
  // - Lookup services help people find things in your overlay

  // Protocols
  server.configureTopicManager('tm_protomap', new ProtoMapTopicManager())
  server.configureLookupServiceWithMongo('ls_protomap', createProtoMapLookupService)

  // Certificates
  server.configureTopicManager('tm_certmap', new CertMapTopicManager())
  server.configureLookupServiceWithMongo('ls_certmap', createCertMapLookupService)

  // Baskets
  server.configureTopicManager('tm_basketmap', new BasketMapTopicManager())
  server.configureLookupServiceWithMongo('ls_basketmap', createBasketMapLookupService)

  // UHRP
  server.configureTopicManager('tm_uhrp', new UHRPTopicManager())
  server.configureLookupServiceWithMongo('ls_uhrp', createUHRPLookupService)

  // Identity
  server.configureTopicManager('tm_identity', new IdentityTopicManager())
  server.configureLookupServiceWithMongo('ls_identity', createIdentityLookupService)

  // MessageBox
  server.configureTopicManager('tm_messagebox', new MessageBoxTopicManager())
  server.configureLookupServiceWithMongo('ls_messagebox', createMessageBoxLookupService)

  // UMP
  server.configureTopicManager('tm_users', new UMPTopicManager())
  server.configureLookupServiceWithMongo('ls_users', createUMPLookupService)

  // HelloWorld
  server.configureTopicManager('tm_helloworld', new HelloWorldTopicManager())
  server.configureLookupServiceWithMongo('ls_helloworld', createHelloWorldLookupService)

  // SlackThread
  server.configureTopicManager('tm_slackthread', new SlackThreadsTopicManager())
  server.configureLookupServiceWithMongo('ls_slackthread', createSlackThreadsLookupService)

  // DesktopIntegrity
  server.configureTopicManager('tm_desktopintegrity', new DesktopIntegrityTopicManager())
  server.configureLookupServiceWithMongo('ls_desktopintegrity', createDesktopIntegrityLookupService)

  // Fractionalize
  server.configureTopicManager('tm_fractionalize', new FractionalizeTopicManager())
  server.configureLookupServiceWithMongo('ls_fractionalize', createFractionalizeLookupService)

  // SupplyChain
  server.configureTopicManager('tm_supplychain', new SupplyChainTopicManager())
  server.configureLookupServiceWithMongo('ls_supplychain', createSupplyChainLookupService)

  // MonsterBattle
  server.configureTopicManager('tm_monsterbattle', new MonsterBattleTopicManager())
  server.configureLookupServiceWithMongo('ls_monsterbattle', createMonsterBattleLookupService)

  // Any
  server.configureTopicManager('tm_anytx', new AnyTopicManager())
  server.configureLookupServiceWithMongo('ls_anytx', createAnyLookupService)

  // Apps
  server.configureTopicManager('tm_apps', new AppsTopicManager())
  server.configureLookupServiceWithMongo('ls_apps', createAppsLookupService)

  // DID
  server.configureTopicManager('tm_did', new DIDTopicManager())
  server.configureLookupServiceWithMongo('ls_did', createDIDLookupService)

  // WalletConfig
  server.configureTopicManager('tm_walletconfig', new WalletConfigTopicManager())
  server.configureLookupServiceWithMongo('ls_walletconfig', createWalletConfigLookupService)

  // TokenDemo
  server.configureTopicManager('tm_tokendemo', new TokenDemoTopicManager())
  server.configureLookupServiceWithMongo('ls_tokendemo', createTokenDemoLookupService)

  // Mandala (BRC-92 regulated token) — verifier/admin wallet derived from the node identity key.
  // NOTE: production must use an HSM/KMS-custodied verifier key (see spec follow-ups); this local
  // wiring reuses SERVER_PRIVATE_KEY and an empty in-memory sanctions list.
  const mandalaWallet = new ProtoWallet(
    PrivateKey.fromHex(SERVER_PRIVATE_KEY)
  ) as unknown as WalletInterface
  let mandalaStorage: MandalaStorageManager | undefined
  const requireMandalaStorage = (): MandalaStorageManager => {
    if (mandalaStorage === undefined) {
      throw new Error('Mandala storage is not initialized')
    }
    return mandalaStorage
  }
  server.configureTopicManager(
    'tm_mandala',
    new MandalaTopicManager({
      verifierWallet: mandalaWallet,
      screeningProvider: new InMemoryScreeningProvider([]),
      adminWallet: mandalaWallet,
      adminProtocolID: [2, 'mandala admin'] as [2, string],
      stateStore: {
        getAssetState: async assetId => await requireMandalaStorage().getAssetState(assetId),
        getTokenRow: async (txid, outputIndex) =>
          await requireMandalaStorage().getTokenRow(txid, outputIndex)
      }
    })
  )
  server.configureLookupServiceWithMongo('ls_mandala', db => {
    mandalaStorage = new MandalaStorageManager(db)
    return createMandalaLookupService(mandalaWallet, mandalaStorage)(db)
  })

  // For simple local deployments, sync can be disabled.
  server.configureEnableGASPSync(process.env?.GASP_ENABLED === 'true')

  // Lastly, configure the engine and start the server!
  await server.configureEngine()

  // Configure verbose request logging
  server.configureVerboseRequestLogging(true)

  server.app.get('/version', (_req: unknown, res: { json: (body: unknown) => void }) => {
    res.json(packageJson)
  })

  // Start the server
  await server.start()
}

// Happy hacking :)
// Wrap startup in a span so a slow/failed boot is visible in traces, and emit
// structured ready/fatal events with timing.
tracer.startActiveSpan('overlay.bootstrap', async span => {
  const startedAt = Date.now()
  try {
    await main()
    const duration_ms = Date.now() - startedAt
    span.setAttribute('node.name', process.env.NODE_NAME ?? 'unknown')
    span.setStatus({ code: SpanStatusCode.OK })
    log.info({ operation: 'bootstrap', outcome: 'ok', duration_ms }, 'overlay-server started')
  } catch (err) {
    const duration_ms = Date.now() - startedAt
    span.recordException(err as Error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message })
    log.error(
      { operation: 'bootstrap', outcome: 'error', duration_ms, err },
      'overlay-server failed to start'
    )
    process.exitCode = 1
  } finally {
    span.end()
  }
})
