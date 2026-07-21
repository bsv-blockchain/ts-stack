import knexLib, { type Knex } from 'knex'
import type { WalletInterface } from '@bsv/sdk'
import { createMessageBoxContext, type MessageBoxContext } from '../../context.js'

export function createTestKnex (): Knex {
  const config = {
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  }
  return (knexLib as any).default?.(config) ?? (knexLib as any)(config)
}

export function createTestWallet (): WalletInterface {
  return {
    internalizeAction: async () => ({ accepted: true })
  } as unknown as WalletInterface
}

export function createTestContext (knex?: Knex): MessageBoxContext {
  return createMessageBoxContext({
    knex: knex ?? createTestKnex(),
    wallet: createTestWallet(),
    enableSwagger: false,
    enableWebSockets: false
  })
}
