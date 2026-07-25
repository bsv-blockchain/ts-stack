/* eslint-env jest */
import knexLib from 'knex'
import {
  createMessageBoxContext,
  createMessageBoxApp,
  registerMessageBoxPreAuthRoutes,
  registerMessageBoxPostAuthRoutes
} from '../compose.js'

describe('compose API', () => {
  it('createMessageBoxContext requires wallet and knex', () => {
    expect(() => createMessageBoxContext({} as any)).toThrow(/wallet/)
  })

  it('register pre/post auth routes attach without throwing', async () => {
    const knexConfig = { client: 'mysql2', connection: {}, useNullAsDefault: true }
    const knex = (knexLib as any).default?.(knexConfig) ?? (knexLib as any)(knexConfig)
    const wallet = {
      getPublicKey: async () => ({ publicKey: '02' + '11'.repeat(32) })
    } as any
    const app = createMessageBoxApp()
    const ctx = createMessageBoxContext({
      wallet,
      knex,
      enableSwagger: false,
      enableWebSockets: false
    })
    expect(() => {
      registerMessageBoxPreAuthRoutes(app)
      registerMessageBoxPostAuthRoutes(app, ctx)
    }).not.toThrow()
    expect(typeof app.use).toBe('function')
    await knex.destroy()
  })
})
