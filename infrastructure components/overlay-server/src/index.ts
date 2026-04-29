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
} from '@bsv/overlay-topics'

import { config } from 'dotenv'
import packageJson from '../package.json'
config()

// Hi there! Let's configure Overlay Express!
const main = async () => {

    // We'll make a new server for our overlay node.
    const server = new OverlayExpress(

        // Name your overlay node with a one-word lowercase string
        process.env.NODE_NAME!,

        // Provide the private key that gives your node its identity
        process.env.SERVER_PRIVATE_KEY!,

        // Provide the HTTPS URL where your node is available on the internet
        process.env.HOSTING_URL!,

        // Provide an adminToken to enable the admin API
        process.env.ADMIN_TOKEN!
    )

    const wa = new WalletAdvertiser(
        process.env.NETWORK! as 'main' | 'test',
        process.env.SERVER_PRIVATE_KEY!,
        process.env.WALLET_STORAGE_URL!,
        process.env.HOSTING_URL!
    )

    await wa.init()

    server.configureEngineParams({
        advertiser: wa
    })

    // Set the ARC API key
    server.configureArcApiKey(process.env.ARC_API_KEY!)

    // Decide what port you want the server to listen on.
    server.configurePort(8080)

    // Connect to your SQL database with Knex
    await server.configureKnex(process.env.KNEX_URL!)

    // Also, be sure to connect to MongoDB
    await server.configureMongo(process.env.MONGO_URL!)

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

    // For simple local deployments, sync can be disabled.
    server.configureEnableGASPSync(process.env?.GASP_ENABLED === 'true')

    // Lastly, configure the engine and start the server!
    await server.configureEngine()

    // Configure verbose request logging
    server.configureVerboseRequestLogging(true)

    server.app.get('/version', (req, res) => {
        res.json(packageJson)
    })

    // Start the server
    await server.start()
}

// Happy hacking :)
main()
