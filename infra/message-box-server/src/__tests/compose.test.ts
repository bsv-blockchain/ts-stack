/* eslint-env jest */
import express from 'express'
import request from 'supertest'
import knexLib from 'knex'
import {
  createMessageBoxContext,
  mountMessageBoxRoutes,
  createMessageBoxApp
} from '../compose.js'
import type { WalletInterface } from '@bsv/sdk'

function mockWallet (): WalletInterface {
  return {
    internalizeAction: async () => ({ accepted: true })
  } as unknown as WalletInterface
}

describe('composable messagebox API', () => {
  it('createMessageBoxContext requires wallet and knex', () => {
    expect(() => createMessageBoxContext({ wallet: null as any, knex: null as any })).toThrow()
  })

  it('mountMessageBoxRoutes registers routes without listen', async () => {
    const knex = (knexLib as any)({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    await knex.schema.createTable('messageBox', (t: any) => {
      t.increments('messageBoxId')
      t.string('identityKey')
      t.string('type')
      t.timestamps(true, true)
    })
    await knex.schema.createTable('messages', (t: any) => {
      t.string('messageId').primary()
      t.integer('messageBoxId')
      t.string('sender')
      t.string('recipient')
      t.text('body')
      t.timestamps(true, true)
    })
    await knex.schema.createTable('message_permissions', (t: any) => {
      t.string('recipient')
      t.string('sender').nullable()
      t.string('message_box')
      t.integer('recipient_fee')
      t.timestamps(true, true)
      t.unique(['recipient', 'sender', 'message_box'])
    })
    await knex.schema.createTable('server_fees', (t: any) => {
      t.string('message_box')
      t.integer('delivery_fee')
    })

    const app = createMessageBoxApp()
    const ctx = createMessageBoxContext({
      wallet: mockWallet(),
      knex,
      enableSwagger: false,
      enableWebSockets: false
    })

    mountMessageBoxRoutes(app, ctx)

    // Without auth middleware identity, listMessages should 401 from auth mw
    // or fail open depending on middleware — smoke that route exists
    const res = await request(app)
      .post('/listMessages')
      .send({ messageBox: 'inbox' })

    // Auth middleware rejects unauthenticated requests
    expect([400, 401, 500]).toContain(res.status)

    await knex.destroy()
  })

  it('routingPrefix is applied', async () => {
    const knex = (knexLib as any)({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })

    const app = express()
    mountMessageBoxRoutes(app, createMessageBoxContext({
      wallet: mockWallet(),
      knex,
      routingPrefix: '/mb',
      enableSwagger: false,
      enableWebSockets: false
    }))

    const bare = await request(app).post('/listMessages').send({})
    expect(bare.status).toBe(404)

    const prefixed = await request(app).post('/mb/listMessages').send({})
    expect(prefixed.status).not.toBe(404)

    await knex.destroy()
  })
})
