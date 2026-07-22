/* eslint-env jest */
import knexLib from 'knex'
import {
  createMessageBoxContext,
  createMessageBoxApp,
  mountMessageBoxRoutes
} from '../compose.js'

describe('compose API', () => {
  it('createMessageBoxContext requires wallet and knex', () => {
    expect(() => createMessageBoxContext({} as any)).toThrow(/wallet/)
  })

  it('mountMessageBoxRoutes attaches without throwing', () => {
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
    expect(() => { mountMessageBoxRoutes(app, ctx) }).not.toThrow()
    expect(typeof app.use).toBe('function')
  })
})
