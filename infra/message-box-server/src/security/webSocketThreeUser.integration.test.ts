import { createServer, type Server as HttpServer } from 'node:http'
import { MessageBoxClient } from '@bsv/message-box-client'
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk'
import knexFactory, { type Knex } from 'knex'
import {
  attachMessageBoxWebSockets,
  closeMessageBoxWebSockets,
  createMessageBoxContext
} from '../compose.js'

const SHARED_DOCUMENT_BOX = 'metanetdocs-shared-document'
const EVENT_TIMEOUT_MS = 10_000

interface ReceivedMessage {
  sender: string
  body: string
}

interface TestUser {
  name: string
  wallet: ProtoWallet
  identityKey: string
  client: MessageBoxClient
  received: ReceivedMessage[]
}

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

function waitForSocketEvent<T>(
  client: MessageBoxClient,
  eventName: string,
  matches: (data: T) => boolean = () => true
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for AuthSocket event ${eventName}`))
    }, EVENT_TIMEOUT_MS)

    client.testSocket?.on(eventName, data => {
      if (!matches(data as T)) return
      clearTimeout(timeout)
      resolve(data as T)
    })
  })
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function connectUser(name: string, wallet: ProtoWallet, host: string): Promise<TestUser> {
  const identityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const client = new MessageBoxClient({ host, walletClient: wallet as WalletInterface })
  const received: ReceivedMessage[] = []

  await client.initializeConnection()
  const roomId = `${identityKey}-${SHARED_DOCUMENT_BOX}`
  const joined = waitForSocketEvent<{ roomId: string }>(
    client,
    'joinedRoom',
    data => data.roomId === roomId
  )
  await client.listenForLiveMessages({
    messageBox: SHARED_DOCUMENT_BOX,
    onMessage: message => {
      received.push({
        sender: message.sender,
        body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body)
      })
    }
  })
  await joined

  return { name, wallet, identityKey, client, received }
}

async function sendTo(sender: TestUser, recipient: TestUser, suffix = ''): Promise<void> {
  const body = `${sender.name} to ${recipient.name}${suffix}`
  await sender.client.sendLiveMessage({
    recipient: recipient.identityKey,
    messageBox: SHARED_DOCUMENT_BOX,
    messageId: `${sender.name}-${recipient.name}${suffix}`,
    body
  })
}

describe('Message Box three-user AuthSocket integration', () => {
  jest.setTimeout(45_000)

  let database: Knex
  let httpServer: HttpServer
  let socketServer: ReturnType<typeof attachMessageBoxWebSockets>
  const connectedClients: MessageBoxClient[] = []

  beforeAll(async () => {
    process.env.MESSAGE_BOX_MONETIZATION_ENABLED = 'false'
    database = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    await createSchema(database)

    httpServer = createServer((_request, response) => response.end())
    socketServer = attachMessageBoxWebSockets(
      httpServer,
      createMessageBoxContext({
        knex: database,
        wallet: new ProtoWallet(new PrivateKey(900)) as WalletInterface,
        enableWebSockets: true,
        enableSwagger: false
      })
    )
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', resolve)
    })
  })

  afterAll(async () => {
    await Promise.all(
      connectedClients.map(async client => {
        try {
          await client.disconnectWebSocket()
        } catch {
          // The shared socket server may already have closed the client.
        }
      })
    )
    await closeMessageBoxWebSockets(socketServer)
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => (error == null ? resolve() : reject(error)))
      })
    }
    await database.destroy()
    delete process.env.MESSAGE_BOX_MONETIZATION_ENABLED
  })

  it('authenticates three shared-document users and delivers every encrypted message bidirectionally', async () => {
    const address = httpServer.address()
    if (address == null || typeof address === 'string') throw new Error('Missing test server port')
    const host = `http://127.0.0.1:${address.port}`

    const users = await Promise.all([
      connectUser('alice', new ProtoWallet(new PrivateKey(101)), host),
      connectUser('bob', new ProtoWallet(new PrivateKey(102)), host),
      connectUser('carol', new ProtoWallet(new PrivateKey(103)), host)
    ])
    connectedClients.push(...users.map(user => user.client))

    for (const sender of users) {
      for (const recipient of users) {
        if (sender !== recipient) await sendTo(sender, recipient)
      }
    }

    await waitFor(
      () => users.every(user => user.received.length === 2),
      'all six remote shared-document deliveries'
    )

    for (const recipient of users) {
      const expected = users
        .filter(sender => sender !== recipient)
        .map(sender => ({
          sender: sender.identityKey,
          body: `${sender.name} to ${recipient.name}`
        }))
      expect(recipient.received).toEqual(expect.arrayContaining(expected))
      expect(recipient.received).toHaveLength(2)
    }
    expect(await database('messages').count<{ count: number }[]>({ count: '*' }).first()).toEqual({
      count: 6
    })

    const bob = users[1]
    await bob.client.disconnectWebSocket()
    const rejoinedBob = await connectUser('bob', bob.wallet, host)
    connectedClients.push(rejoinedBob.client)

    await sendTo(users[0], rejoinedBob, '-after-rejoin')
    await waitFor(
      () => rejoinedBob.received.length === 1,
      'delivery to the reauthenticated shared-document user'
    )

    expect(rejoinedBob.received).toEqual([
      {
        sender: users[0].identityKey,
        body: 'alice to bob-after-rejoin'
      }
    ])
    expect(bob.received).toHaveLength(2)
    expect(await database('messages').count<{ count: number }[]>({ count: '*' }).first()).toEqual({
      count: 7
    })
  })
})
