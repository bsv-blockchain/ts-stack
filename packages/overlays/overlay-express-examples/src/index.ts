import { WalletAdvertiser } from '@bsv/overlay-discovery-services'
import OverlayExpress from '@bsv/overlay-express'
import ProtoMapTopicManager from './services/protomap/ProtoMapTopicManager'
import ProtoMapLookupService from './services/protomap/ProtoMapLookupServiceFactory'
import CertMapTopicManager from './services/certmap/CertMapTopicManager'
import CertMapLookupService from './services/certmap/CertMapLookupServiceFactory'
import BasketMapTopicManager from './services/basketmap/BasketMapTopicManager'
import BasketMapLookupService from './services/basketmap/BasketMapLookupServiceFactory'
import UHRPTopicManager from './services/uhrp/UHRPTopicManager'
import UHRPLookupService from './services/uhrp/UHRPLookupServiceFactory'
import IdentityTopicManager from './services/identity/IdentityTopicManager'
import IdentityLookupService from './services/identity/IdentityLookupServiceFactory'
import MessageBoxTopicManager from './services/message-box/MessageBoxTopicManager'
import MessageBoxLookupService from './services/message-box/MessageBoxLookupService'
import UMPTopicManager from './services/ump/UMPTopicManager'
import UMPLookupService from './services/ump/UMPLookupServiceFactory'
import HelloWorldTopicManager from './services/hello/HelloWorldTopicManager'
import HelloWorldLookupService from './services/hello/HelloWorldLookupServiceFactory'
import SlackThreadTopicManager from './services/slackthreads/SlackThreadsTopicManager'
import SlackThreadLookupService from './services/slackthreads/SlackThreadsLookupServiceFactory'
import DesktopIntegrityTopicManager from './services/desktopintegrity/DesktopIntegrityTopicManager'
import DesktopIntegrityLookupService from './services/desktopintegrity/DesktopIntegrityLookupServiceFactory'
import FractionalizeTopicManager from './services/fractionalize/FractionalizeTopicManager'
import FractionalizeLookupService from './services/fractionalize/FractionalizeLookupServiceFactory'
import SupplyChainTopicManager from './services/supplychain/SupplyChainTopicManager'
import SupplyChainLookupService from './services/supplychain/SupplyChainLookupServiceFactory'
import MonsterBattleTopicManager from './services/monsterbattle/MonsterBattleTopicManager'
import MonsterBattleLookupService from './services/monsterbattle/MonsterBattleLookupServiceFactory'
import AnyTopicManager from './services/any/AnyTopicManager'
import AnyLookupService from './services/any/AnyLookupServiceFactory'
import AppsTopicManager from './services/apps/AppsTopicManager'
import AppsLookupService from './services/apps/AppsLookupServiceFactory'
import DIDTopicManager from './services/did/DIDTopicManager'
import DIDLookupService from './services/did/DIDLookupServiceFactory'
import WalletConfigTopicManager from './services/walletconfig/WalletConfigTopicManager'
import WalletConfigLookupService from './services/walletconfig/WalletConfigLookupServiceFactory'
import TokenDemoTopicManager from './services/utility-tokens/TokenDemoTopicManager'
import TokenDemoLookupService from './services/utility-tokens/TokenDemoLookupServiceFactory'

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
    server.configureLookupServiceWithMongo('ls_protomap', ProtoMapLookupService)

    // Certificates
    server.configureTopicManager('tm_certmap', new CertMapTopicManager())
    server.configureLookupServiceWithMongo('ls_certmap', CertMapLookupService)

    // Baskets
    server.configureTopicManager('tm_basketmap', new BasketMapTopicManager())
    server.configureLookupServiceWithMongo('ls_basketmap', BasketMapLookupService)

    // UHRP
    server.configureTopicManager('tm_uhrp', new UHRPTopicManager())
    server.configureLookupServiceWithMongo('ls_uhrp', UHRPLookupService)

    // Identity
    server.configureTopicManager('tm_identity', new IdentityTopicManager())
    server.configureLookupServiceWithMongo('ls_identity', IdentityLookupService)

    // MessageBox
    server.configureTopicManager('tm_messagebox', new MessageBoxTopicManager())
    server.configureLookupServiceWithMongo('ls_messagebox', MessageBoxLookupService)

    // UMP
    server.configureTopicManager('tm_users', new UMPTopicManager())
    server.configureLookupServiceWithMongo('ls_users', UMPLookupService)

    // HelloWorld
    server.configureTopicManager('tm_helloworld', new HelloWorldTopicManager())
    server.configureLookupServiceWithMongo('ls_helloworld', HelloWorldLookupService)

    // SlackThread
    server.configureTopicManager('tm_slackthread', new SlackThreadTopicManager())
    server.configureLookupServiceWithMongo('ls_slackthread', SlackThreadLookupService)

    // DesktopIntegrity
    server.configureTopicManager('tm_desktopintegrity', new DesktopIntegrityTopicManager())
    server.configureLookupServiceWithMongo('ls_desktopintegrity', DesktopIntegrityLookupService)

    // Fractionalize
    server.configureTopicManager('tm_fractionalize', new FractionalizeTopicManager())
    server.configureLookupServiceWithMongo('ls_fractionalize', FractionalizeLookupService)

    // SupplyChain
    server.configureTopicManager('tm_supplychain', new SupplyChainTopicManager())
    server.configureLookupServiceWithMongo('ls_supplychain', SupplyChainLookupService)

    // MonsterBattle
    server.configureTopicManager('tm_monsterbattle', new MonsterBattleTopicManager())
    server.configureLookupServiceWithMongo('ls_monsterbattle', MonsterBattleLookupService)

    // Any
    server.configureTopicManager('tm_anytx', new AnyTopicManager())
    server.configureLookupServiceWithMongo('ls_anytx', AnyLookupService)

    // Apps
    server.configureTopicManager('tm_apps', new AppsTopicManager())
    server.configureLookupServiceWithMongo('ls_apps', AppsLookupService)

    // DID
    server.configureTopicManager('tm_did', new DIDTopicManager())
    server.configureLookupServiceWithMongo('ls_did', DIDLookupService)

    // WalletConfig
    server.configureTopicManager('tm_walletconfig', new WalletConfigTopicManager())
    server.configureLookupServiceWithMongo('ls_walletconfig', WalletConfigLookupService)

    // TokenDemo
    server.configureTopicManager('tm_tokendemo', new TokenDemoTopicManager())
    server.configureLookupServiceWithMongo('ls_tokendemo', TokenDemoLookupService)

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