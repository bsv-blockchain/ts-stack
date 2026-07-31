/* eslint-env jest */
import knexLib from 'knex'
import request from 'supertest'
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
      getPublicKey: async () => ({ publicKey: '02' + '11'.repeat(32) }),
      internalizeAction: async () => ({ accepted: true })
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

  it('rate-limits authenticated work before payment middleware', async () => {
    const knexConfig = { client: 'mysql2', connection: {}, useNullAsDefault: true }
    const knex = (knexLib as any).default?.(knexConfig) ?? (knexLib as any)(knexConfig)
    const wallet = {
      getPublicKey: async () => ({ publicKey: '02' + '11'.repeat(32) }),
      internalizeAction: async () => ({ accepted: true })
    } as any
    const app = createMessageBoxApp()
    const ctx = createMessageBoxContext({
      wallet,
      knex,
      enableSwagger: false,
      enableWebSockets: false,
      calculateRequestPrice: () => 0
    })
    app.use((req, _res, next) => {
      ;(req as typeof req & { auth: { identityKey: string } }).auth = {
        identityKey: '02' + '22'.repeat(32)
      }
      next()
    })
    registerMessageBoxPostAuthRoutes(app, ctx, '', {
      windowMs: 60_000,
      limit: 1
    })

    await request(app).get('/not-a-route')
    const rejected = await request(app).get('/not-a-route')
    expect(rejected.status).toBe(429)
    expect(rejected.body).toEqual({
      status: 'error',
      code: 'ERR_RATE_LIMITED',
      description: 'Too many requests. Please retry later.'
    })
    await knex.destroy()
  })
})
