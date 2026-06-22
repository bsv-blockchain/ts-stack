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
    createMandalaLookupService,
    InMemoryScreeningProvider,
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
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return value
}

// Hi there! Let's configure Overlay Express!
const main = async () => {
    // Validate required configuration up front so misconfiguration fails fast.
    const NODE_NAME = requireEnv('NODE_NAME')
    const SERVER_PRIVATE_KEY = requireEnv('SERVER_PRIVATE_KEY')
    const HOSTING_URL = requireEnv('HOSTING_URL')
    const WALLET_STORAGE_URL = requireEnv('WALLET_STORAGE_URL')
    const ARC_API_KEY = requireEnv('ARC_API_KEY')
    const KNEX_URL = requireEnv('KNEX_URL')
    const MONGO_URL = requireEnv('MONGO_URL')
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN // optional: a random token is generated if unset

    const NETWORK = requireEnv('NETWORK')
    if (NETWORK !== 'main' && NETWORK !== 'test') {
        throw new Error(`NETWORK must be "main" or "test", got: ${NETWORK}`)
    }

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

    const wa = new WalletAdvertiser(
        NETWORK,
        SERVER_PRIVATE_KEY,
        WALLET_STORAGE_URL,
        HOSTING_URL
    )

    await wa.init()

    server.configureEngineParams({
        advertiser: wa
    })

    // Set the ARC API key
    server.configureArcApiKey(ARC_API_KEY)

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
    const mandalaWallet = new ProtoWallet(PrivateKey.fromHex(SERVER_PRIVATE_KEY)) as unknown as WalletInterface
    server.configureTopicManager('tm_mandala', new MandalaTopicManager({
        verifierWallet: mandalaWallet,
        screeningProvider: new InMemoryScreeningProvider([]),
        adminWallet: mandalaWallet,
        adminProtocolID: [2, 'mandala admin'] as [2, string]
    }))
    server.configureLookupServiceWithMongo('ls_mandala', createMandalaLookupService(mandalaWallet))

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
tracer.startActiveSpan('overlay.bootstrap', async (span) => {
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
        log.error({ operation: 'bootstrap', outcome: 'error', duration_ms, err }, 'overlay-server failed to start')
        process.exitCode = 1
    } finally {
        span.end()
    }
})
