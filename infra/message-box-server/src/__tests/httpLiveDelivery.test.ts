import { createServer, type Server as HttpServer } from 'node:http'
import express from 'express'
import request from 'supertest'
import { MessageBoxClient } from '@bsv/message-box-client'
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk'
import knexFactory, { type Knex } from 'knex'
import {
  attachMessageBoxWebSockets,
  closeMessageBoxWebSockets,
  createMessageBoxContext,
  registerMessageBoxPostAuthRoutes
} from '../compose.js'

const BOX = 'live_http_box'
const EVENT_TIMEOUT_MS = 10_000

async function createSchema(database: Knex): Promise<void> {
  await database.schema.createTable('messageBox', table => {
    table.increments('messageBoxId').primary()
    table.timestamps(true, true)
    table.string('type').notNullable()
    table.string('identityKey').notNullable()
    table.unique(['type', 'identityKey'])
  })
  await database.schema.createTable('messages', table => {
    table.string('messageId').primary()
    table.timestamps(true, true)
    table.integer('messageBoxId').notNullable()
    table.string('sender').notNullable()
    table.string('recipient').notNullable()
    table.text('body').notNullable()
    table.timestamp('expires_at').nullable()
  })
  await database.schema.createTable('message_permissions', table => {
    table.increments('id').primary()
    table.string('recipient').notNullable()
    table.string('sender').nullable()
    table.string('sender_scope').notNullable().defaultTo('')
    table.string('message_box').notNullable()
    table.integer('recipient_fee').notNullable()
    table.unique(['recipient', 'message_box', 'sender_scope'])
  })
  await database.schema.createTable('server_fees', table => {
    table.increments('id').primary()
    table.string('message_box').notNullable().unique()
    table.integer('delivery_fee').notNullable()
  })
  await database.schema.createTable('message_resource_locks', table => {
    table.string('identity_key').primary()
    table.timestamp('updated_at').notNullable()
  })
}

function serverWallet(): WalletInterface {
  return Object.assign(new ProtoWallet(new PrivateKey(900)), {
    internalizeAction: async () => ({ accepted: true })
  }) as unknown as WalletInterface
}

function buildApp(ctx: ReturnType<typeof createMessageBoxContext>, senderKey: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as typeof req & { auth: { identityKey: string } }).auth = { identityKey: senderKey }
    next()
  })
  registerMessageBoxPostAuthRoutes(app, ctx)
  return app
}

describe('HTTP sendMessage live delivery', () => {
  jest.setTimeout(45_000)

  let database: Knex
  let httpServer: HttpServer | undefined
  let client: MessageBoxClient | undefined

  const recipientWallet = new ProtoWallet(new PrivateKey(201))
  const senderKey = new PrivateKey(202).toPublicKey().toString()

  beforeAll(() => {
    process.env.MESSAGE_BOX_MONETIZATION_ENABLED = 'false'
  })

  beforeEach(async () => {
    database = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    await createSchema(database)
  })

  afterEach(async () => {
    try {
      await client?.disconnectWebSocket()
    } catch {
      // Server may already have closed the socket.
    }
    client = undefined
    if (httpServer?.listening === true) {
      await new Promise<void>(resolve => httpServer?.close(() => resolve()))
    }
    httpServer = undefined
    await database.destroy()
  })

  afterAll(() => {
    delete process.env.MESSAGE_BOX_MONETIZATION_ENABLED
  })

  it('pushes an HTTP-stored message to a connected recipient joined to the room', async () => {
    const recipientKey = (await recipientWallet.getPublicKey({ identityKey: true })).publicKey
    const ctx = createMessageBoxContext({
      knex: database,
      wallet: serverWallet(),
      enableWebSockets: true,
      enableSwagger: false
    })
    const app = buildApp(ctx, senderKey)
    httpServer = createServer(app)
    const io = attachMessageBoxWebSockets(httpServer, ctx)
    await new Promise<void>(resolve => httpServer?.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (address == null || typeof address === 'string') throw new Error('Missing test server port')

    client = new MessageBoxClient({
      host: `http://127.0.0.1:${address.port}`,
      walletClient: recipientWallet as WalletInterface
    })
    await client.initializeConnection()
    const roomId = `${recipientKey}-${BOX}`
    const pushes: Array<{ sender: string; messageId: string; body: string }> = []
    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('joinedRoom timeout')), EVENT_TIMEOUT_MS)
      client?.testSocket?.on('joinedRoom', (data: { roomId: string }) => {
        if (data.roomId !== roomId) return
        clearTimeout(timer)
        resolve()
      })
    })
    await client.listenForLiveMessages({
      messageBox: BOX,
      onMessage: message => {
        pushes.push({
          sender: message.sender,
          messageId: message.messageId,
          body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body)
        })
      }
    })
    await joined

    const response = await request(app)
      .post('/sendMessage')
      .send({ message: { recipient: recipientKey, messageBox: BOX, messageId: 'm-1', body: 'hi' } })
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('success')

    const deadline = Date.now() + EVENT_TIMEOUT_MS
    while (pushes.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(pushes).toEqual([{ sender: senderKey, messageId: 'm-1', body: 'hi' }])
    await closeMessageBoxWebSockets(io)
  })

  it('stores and returns 200 without notifying when WebSockets are disabled', async () => {
    const recipientKey = (await recipientWallet.getPublicKey({ identityKey: true })).publicKey
    const ctx = createMessageBoxContext({
      knex: database,
      wallet: serverWallet(),
      enableWebSockets: false,
      enableSwagger: false
    })
    const app = buildApp(ctx, senderKey)
    httpServer = createServer(app)

    expect(attachMessageBoxWebSockets(httpServer, ctx)).toBeNull()
    expect(ctx.liveDelivery.connections).toBeNull()

    const response = await request(app)
      .post('/sendMessage')
      .send({ message: { recipient: recipientKey, messageBox: BOX, messageId: 'm-2', body: 'hi' } })
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('success')
    const stored = await database('messages').where({ messageId: 'm-2' })
    expect(stored).toHaveLength(1)
  })
})
