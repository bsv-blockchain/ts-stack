/**
 * Standalone binary helpers: knex + wallet from env.
 * Parent apps should inject their own knex/wallet via createMessageBoxContext.
 */

import * as dotenv from 'dotenv'
import knexLib, { Knex } from 'knex'
import knexConfig from '../knexfile.js'
import type { WalletInterface } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'
import { Logger } from './utils/logger.js'
import * as crypto from 'crypto'
;(global.self as any) = { crypto }

dotenv.config()

const {
  NODE_ENV = 'development',
  SERVER_PRIVATE_KEY,
  WALLET_STORAGE_URL,
  BSV_NETWORK = 'mainnet',
  LOGGING_ENABLED
} = process.env

if (NODE_ENV === 'development' || LOGGING_ENABLED === 'true') {
  Logger.enable()
}

export function createKnexFromEnv (): Knex {
  const config =
    NODE_ENV === 'production' || NODE_ENV === 'staging'
      ? knexConfig.production
      : knexConfig.development

  return (knexLib as any).default?.(config) ?? (knexLib as any)(config)
}

export async function createWalletFromEnv (): Promise<WalletInterface> {
  if (SERVER_PRIVATE_KEY == null || SERVER_PRIVATE_KEY.trim() === '') {
    throw new Error('SERVER_PRIVATE_KEY is not defined in environment variables.')
  }

  return await Setup.createWalletClientNoEnv({
    chain: BSV_NETWORK === 'testnet' ? 'test' : 'main',
    rootKeyHex: SERVER_PRIVATE_KEY,
    storageUrl: WALLET_STORAGE_URL
  })
}
