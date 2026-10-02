import { createServer, type Server as HttpServer } from 'node:http'
import express from 'express'
import request from 'supertest'
import { MessageBoxClient } from '@bsv/message-box-client'
import {
  Beef,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  type WalletInterface
} from '@bsv/sdk'
import knexFactory, { type Knex } from 'knex'
import { KnexPaymentReplayStore } from '../security/KnexPaymentReplayStore.js'
import {
  attachMessageBoxWebSockets,
  closeMessageBoxWebSockets,
  createMessageBoxContext,
  registerMessageBoxPostAuthRoutes
} from '../compose.js'

const BOX = 'live_http_box'
const EVENT_TIMEOUT_MS = 10_000
const QUIET_MS = 500

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
  await database.schema.createTable('payment_replays', table => {
    table.string('transaction_id', 64).primary()
    table.timestamp('created_at').notNullable()
    table.timestamp('expires_at').nullable()
  })
  await database.schema.createTable('message_payment_intents', table => {
    table.string('transaction_id', 64).primary()
    table.string('request_digest', 64).notNullable()
    table.string('status', 32).notNullable()
    table.string('attempt_token', 64).notNullable()
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()
  })
}

/** A BRC-29 output locked to `recipient`, the shape a recipient fee is paid in. */
async function recipientPayment(recipient: string): Promise<Record<string, unknown>> {
  const derivationPrefix = 'cHJlZml4'
  const derivationSuffix = 'c3VmZml4'
  const anyone = new ProtoWallet('anyone')
  const { publicKey } = await anyone.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipient
  })
  const transaction = new Transaction()
  transaction.addOutput({
    satoshis: 1,
    lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress())
  })
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return {
    tx: beef.toBinaryAtomic(transaction.id('hex')),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: (await anyone.getPublicKey({ identityKey: true })).publicKey
        }
      }
    ],
    description: 'Recipient payment'
  }
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

  type Push = { sender: string; messageId: string; body: string }

  function newContext(enableWebSockets: boolean) {
    return createMessageBoxContext({
      knex: database,
      wallet: serverWallet(),
      enableWebSockets,
      enableSwagger: false
    })
  }

  async function listen(server: HttpServer): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address == null || typeof address === 'string') throw new Error('Missing test server port')
    return `http://127.0.0.1:${address.port}`
  }

  async function joinRecipient(host: string, pushes: Push[]): Promise<string> {
    const recipientKey = (await recipientWallet.getPublicKey({ identityKey: true })).publicKey
    client = new MessageBoxClient({ host, walletClient: recipientWallet as WalletInterface })
    await client.initializeConnection()
    const roomId = `${recipientKey}-${BOX}`
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
    return recipientKey
  }

  /** Wait for the first push, then a quiet period so a duplicate emit is seen. */
  async function settle(pushes: Push[]): Promise<void> {
    const deadline = Date.now() + EVENT_TIMEOUT_MS
    while (pushes.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await new Promise(resolve => setTimeout(resolve, QUIET_MS))
  }

  it('pushes an HTTP-stored message exactly once to a joined recipient', async () => {
    const ctx = newContext(true)
    const app = buildApp(ctx, senderKey)
    httpServer = createServer(app)
    const io = attachMessageBoxWebSockets(httpServer, ctx)
    const pushes: Push[] = []
    const recipientKey = await joinRecipient(await listen(httpServer), pushes)

    const response = await request(app)
      .post('/sendMessage')
      .send({ message: { recipient: recipientKey, messageBox: BOX, messageId: 'm-1', body: 'hi' } })
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('success')

    await settle(pushes)
    expect(pushes).toEqual([{ sender: senderKey, messageId: 'm-1', body: 'hi' }])
    await closeMessageBoxWebSockets(io)
  })

  it('does not push an HTTP-stored message that carries a recipient payment', async () => {
    // The push carries the request body, which has no payment in it, and the
    // live handler never internalizes one. A consumer that acknowledges on the
    // push would delete the stored row before the recipient's wallet ever saw
    // the output, so the sender pays and the recipient receives nothing.
    const ctx = createMessageBoxContext({
      knex: database,
      wallet: serverWallet(),
      enableWebSockets: true,
      enableSwagger: false,
      paymentReplayStore: new KnexPaymentReplayStore(database, 1),
      paymentTransactionVerifier: async () => true
    })
    const app = buildApp(ctx, senderKey)
    httpServer = createServer(app)
    const io = attachMessageBoxWebSockets(httpServer, ctx)
    const pushes: Push[] = []
    const recipientKey = await joinRecipient(await listen(httpServer), pushes)
    await database('message_permissions').insert({
      recipient: recipientKey,
      sender: null,
      sender_scope: '',
      message_box: BOX,
      recipient_fee: 1
    })

    const response = await request(app)
      .post('/sendMessage')
      .send({
        message: { recipient: recipientKey, messageBox: BOX, messageId: 'm-paid', body: 'hi' },
        payment: await recipientPayment(recipientKey)
      })
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('success')

    const stored = await database('messages').where({ messageId: 'm-paid' }).first('body')
    expect(JSON.parse(stored.body).payment).toBeDefined()

    await new Promise(resolve => setTimeout(resolve, QUIET_MS))
    expect(pushes).toEqual([])
    await closeMessageBoxWebSockets(io)
  })

  it('pushes a WebSocket-sent message exactly once to a joined recipient', async () => {
    const ctx = newContext(true)
    const app = buildApp(ctx, senderKey)
    httpServer = createServer(app)
    const io = attachMessageBoxWebSockets(httpServer, ctx)
    const host = await listen(httpServer)
    const pushes: Push[] = []
    const recipientKey = await joinRecipient(host, pushes)

    const senderWallet = new ProtoWallet(new PrivateKey(203))
    const sender = new MessageBoxClient({ host, walletClient: senderWallet as WalletInterface })
    await sender.initializeConnection()
    try {
      await sender.sendLiveMessage({
        recipient: recipientKey,
        messageBox: BOX,
        messageId: 'm-ws',
        body: 'hi'
      })
      await settle(pushes)
      const senderIdentity = (await senderWallet.getPublicKey({ identityKey: true })).publicKey
      expect(pushes).toEqual([{ sender: senderIdentity, messageId: 'm-ws', body: 'hi' }])
    } finally {
      await sender.disconnectWebSocket().catch(() => undefined)
    }
    await closeMessageBoxWebSockets(io)
  })

  it('stores and returns 200 but pushes nothing when the route context has WebSockets disabled', async () => {
    const socketCtx = newContext(true)
    httpServer = createServer()
    const io = attachMessageBoxWebSockets(httpServer, socketCtx)
    const pushes: Push[] = []
    const recipientKey = await joinRecipient(await listen(httpServer), pushes)

    const disabledCtx = newContext(false)
    expect(attachMessageBoxWebSockets(createServer(), disabledCtx)).toBeNull()
    const app = buildApp(disabledCtx, senderKey)
    const response = await request(app)
      .post('/sendMessage')
      .send({ message: { recipient: recipientKey, messageBox: BOX, messageId: 'm-2', body: 'hi' } })
    expect(response.status).toBe(200)
    expect(response.body.status).toBe('success')

    await new Promise(resolve => setTimeout(resolve, QUIET_MS))
    expect(pushes).toEqual([])
    expect(await database('messages').where({ messageId: 'm-2' })).toHaveLength(1)
    await closeMessageBoxWebSockets(io)
  })

  it('rejects a second attach on one context', async () => {
    const ctx = newContext(true)
    httpServer = createServer()
    const io = attachMessageBoxWebSockets(httpServer, ctx)
    expect(() => attachMessageBoxWebSockets(createServer(), ctx)).toThrow(/one attach/)
    await closeMessageBoxWebSockets(io)
  })

  it('refuses to mount the send route without a liveDelivery handle', () => {
    const ctx = { ...newContext(true), liveDelivery: undefined }
    expect(() => registerMessageBoxPostAuthRoutes(express(), ctx as never)).toThrow(/liveDelivery/)
  })
})
