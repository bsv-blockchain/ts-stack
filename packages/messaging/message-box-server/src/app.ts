/**
 * @file app.ts
 * @description
 * Initializes the MessageBoxServer Express app.
 *
 * Responsibilities:
 * - Parses environment variables and loads config
 * - Sets up Knex for DB access
 * - Initializes WalletClient from the BSV SDK
 * - Mounts Express routes (pre-auth and post-auth)
 * - Applies auth middleware using wallet identity
 *
 * This file exports:
 * - `app`: the configured Express instance
 * - `walletReady`: a promise that resolves once the wallet is ready
 * - `getWallet()`: async accessor for the WalletClient
 * - `useRoutes()`: middleware + route initialization
 * - `appReady`: promise that completes once all setup is done
 */

import * as dotenv from 'dotenv'
import express, {
  Express,
  Request as ExpressRequest,
  Response,
  NextFunction,
  RequestHandler
} from 'express'
import bodyParser from 'body-parser'
import { preAuth, postAuth } from './routes/index.js'
import { Logger } from './utils/logger.js'
import sendMessageRoute from './routes/sendMessage.js'
import { Setup } from '@bsv/wallet-toolbox'
import knexLib, { Knex } from 'knex'
import knexConfig from '../knexfile.js'
import type { WalletInterface } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '@bsv/payment-express-middleware'
import { setupSwagger } from './swagger.js'
import * as crypto from 'crypto'
(global.self as any) = { crypto }

dotenv.config()

// Create the Express app instance
export const app: Express = express()

// Load environment variables
const {
  NODE_ENV = 'development',
  ROUTING_PREFIX = '',
  SERVER_PRIVATE_KEY,
  WALLET_STORAGE_URL,
  BSV_NETWORK = 'mainnet'
} = process.env

// Enable logger in dev mode or if explicitly enabled
if (NODE_ENV === 'development' || process.env.LOGGING_ENABLED === 'true') {
  Logger.enable()
}

/**
 * Knex instance connected based on environment (development, production, or staging).
 */
export const knex: Knex = (knexLib as any).default?.(
  NODE_ENV === 'production' || NODE_ENV === 'staging'
    ? knexConfig.production
    : knexConfig.development
) ?? (knexLib as any)(
  NODE_ENV === 'production' || NODE_ENV === 'staging'
    ? knexConfig.production
    : knexConfig.development
)

// Wallet initialization logic
let _wallet: WalletInterface | undefined
let _resolveReady: () => void
export const walletReady = new Promise<void>((resolve) => {
  _resolveReady = resolve
})

/**
 * @function initializeWallet
 * @description Initializes the WalletClient with a root identity key and storage backend.
 *
 * Loads configuration from the environment and connects to the wallet service.
 *
 * @returns {Promise<void>} Resolves when the wallet is initialized.
 * @throws If SERVER_PRIVATE_KEY is missing or invalid.
 */
export async function initializeWallet (): Promise<void> {
  if (SERVER_PRIVATE_KEY == null || SERVER_PRIVATE_KEY.trim() === '') {
    throw new Error('SERVER_PRIVATE_KEY is not defined in environment variables.')
  }

  _wallet = await Setup.createWalletClientNoEnv({
    chain: BSV_NETWORK === 'testnet' ? 'test' : 'main',
    rootKeyHex: SERVER_PRIVATE_KEY,
    storageUrl: WALLET_STORAGE_URL
  })

  _resolveReady()
}

/**
 * @function getWallet
 * @description Waits for the WalletClient to be ready and returns the instance.
 *
 * @returns {Promise<WalletInterface>} The initialized wallet client
 * @throws {Error} If called before the wallet is initialized
 */
export async function getWallet (): Promise<WalletInterface> {
  await walletReady
  if (_wallet == null) {
    throw new Error('Wallet has not been initialized yet.')
  }
  return _wallet
}

// Run on app startup to prep wallet and activate routes
export const appReady = (async () => {
  await initializeWallet()
  await useRoutes()
})()

/**
 * @function useRoutes
 * @description Registers all routes and middleware on the Express app instance.
 *
 * Steps:
 * - Applies JSON body parser
 * - Enables CORS headers for all routes
 * - Waits for WalletClient to initialize
 * - Adds authentication middleware
 * - Mounts pre-auth and post-auth route handlers
 *
 * @returns {Promise<void>} Once all middleware and routes are mounted
 * @throws If wallet is not available when needed
 */
export async function useRoutes (): Promise<void> {
  // Parse incoming JSON bodies with a high limit
  app.use(bodyParser.json({ limit: '1gb', type: 'application/json' }))

  // CORS setup
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Headers', '*')
    res.header('Access-Control-Allow-Methods', '*')
    res.header('Access-Control-Expose-Headers', '*')
    res.header('Access-Control-Allow-Private-Network', 'true')

    if (req.method === 'OPTIONS') {
      res.sendStatus(200)
    } else {
      next()
    }
  })

  // Enable Swagger docs
  setupSwagger(app)

  await walletReady
  if (_wallet == null) {
    throw new Error('Wallet is not initialized for auth middleware')
  }

  app.use(
    createAuthMiddleware({
      wallet: _wallet,
      logger: console
    })
  )

  app.use(
    createPaymentMiddleware({
      wallet: _wallet,
      calculateRequestPrice: async (req: Request) => {
        if (req.url.includes('/sendMessage')) {
          // TODO: Configure a custom price calculation as needed.
        }
        return 0
      }
    })
  )

  // Register pre-authentication routes (no auth required)
  preAuth.forEach((route) => {
    app[route.type as 'get' | 'post' | 'put' | 'delete'](
      `${String(ROUTING_PREFIX)}${String(route.path)}`,
      route.func as unknown as (req: ExpressRequest, res: Response, next: NextFunction) => void
    )
  })

  // Register post-authentication routes (requires auth header)
  postAuth.forEach((route) => {
    if (route.path === '/sendMessage') {
      app[route.type as 'get' | 'post' | 'put' | 'delete'](
        `${ROUTING_PREFIX}${route.path}`,
        sendMessageRoute.func as unknown as RequestHandler
      )
    } else {
      app[route.type as 'get' | 'post' | 'put' | 'delete'](
        `${ROUTING_PREFIX}${route.path}`,
        route.func as RequestHandler
      )
    }
  })
}
