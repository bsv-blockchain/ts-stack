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
import express, { Express } from 'express'
import bodyParser from 'body-parser'
import { Logger } from './utils/logger.js'
import { Setup } from '@bsv/wallet-toolbox'
import knexLib, { Knex } from 'knex'
import knexConfig from '../knexfile.js'
import type { WalletInterface } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { rateLimit } from 'express-rate-limit'
import { setupSwagger } from './swagger.js'
import { bindMessageBoxRuntime } from './runtimeDeps.js'
import { registerMessageBoxPreAuthRoutes, registerMessageBoxPostAuthRoutes } from './compose.js'
import * as crypto from 'node:crypto'
import { configureTrustProxy, rateLimitOptions } from './security/rateLimitPolicy.js'
import {
  bodyParserErrorHandler,
  concurrencyLimit,
  corsPolicy,
  readBodyLimitBytes,
  securityHeaders
} from './security/edgePolicy.js'
;(global.self as any) = { crypto }

dotenv.config()

// Create the Express app instance
export const app: Express = express()
app.disable('x-powered-by')
configureTrustProxy(app)

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
export const knex: Knex =
  (knexLib as any).default?.(
    NODE_ENV === 'production' || NODE_ENV === 'staging'
      ? knexConfig.production
      : knexConfig.development
  ) ??
  (knexLib as any)(
    NODE_ENV === 'production' || NODE_ENV === 'staging'
      ? knexConfig.production
      : knexConfig.development
  )

// Wallet initialization logic
let _wallet: WalletInterface | undefined
let _resolveReady: () => void
export const walletReady = new Promise<void>(resolve => {
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
export async function initializeWallet(): Promise<void> {
  if (SERVER_PRIVATE_KEY == null || SERVER_PRIVATE_KEY.trim() === '') {
    throw new Error('SERVER_PRIVATE_KEY is not defined in environment variables.')
  }

  _wallet = await Setup.createWalletClientNoEnv({
    chain: BSV_NETWORK === 'testnet' ? 'test' : 'main',
    rootKeyHex: SERVER_PRIVATE_KEY,
    storageUrl: WALLET_STORAGE_URL
  })

  bindMessageBoxRuntime({ knex, wallet: _wallet })
  _resolveReady()
}

/**
 * @function getWallet
 * @description Waits for the WalletClient to be ready and returns the instance.
 *
 * @returns {Promise<WalletInterface>} The initialized wallet client
 * @throws {Error} If called before the wallet is initialized
 */
export async function getWallet(): Promise<WalletInterface> {
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
 * - Applies the configured public, allowlist, or disabled CORS policy
 * - Waits for WalletClient to initialize
 * - Adds authentication middleware
 * - Mounts pre-auth and post-auth route handlers
 *
 * @returns {Promise<void>} Once all middleware and routes are mounted
 * @throws If wallet is not available when needed
 */
export async function useRoutes(): Promise<void> {
  app.use(
    securityHeaders({
      environmentPrefix: 'MESSAGE_BOX',
      contentSecurityPolicy:
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    })
  )
  app.use(
    corsPolicy({
      environmentPrefix: 'MESSAGE_BOX',
      methods: ['GET', 'POST', 'OPTIONS']
    })
  )
  app.use(concurrencyLimit('MESSAGE_BOX', 200))
  app.use(
    rateLimit(rateLimitOptions('MESSAGE_BOX_PRE_AUTH_RATE_LIMIT', { windowMs: 60_000, limit: 300 }))
  )
  app.use(
    bodyParser.json({
      limit: readBodyLimitBytes('MESSAGE_BOX', 4 * 1024 * 1024),
      type: 'application/json'
    })
  )
  app.use(bodyParserErrorHandler)

  // Enable Swagger docs
  setupSwagger(app)

  await walletReady
  if (_wallet == null) {
    throw new Error('Wallet is not initialized for auth middleware')
  }

  registerMessageBoxPreAuthRoutes(app, ROUTING_PREFIX)

  app.use(
    createAuthMiddleware({
      wallet: _wallet,
      logger: console
    })
  )

  registerMessageBoxPostAuthRoutes(
    app,
    {
      wallet: _wallet,
      // Message delivery is free unless an embedding operator injects a price
      // calculator through the composable context.
      calculateRequestPrice: () => 0
    },
    ROUTING_PREFIX
  )
}
