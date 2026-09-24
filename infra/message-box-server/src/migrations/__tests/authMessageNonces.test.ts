import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import knexFactory, { type Knex } from 'knex'
import {
  AuthFetch,
  Peer,
  PrivateKey,
  CompletedProtoWallet,
  SimplifiedFetchTransport
} from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { KnexSessionManager } from '@bsv/wallet-toolbox'
import { up as createServiceTables } from '../2026-08-04-001-resource-safety.js'
import { down, up } from '../2026-09-24-001-auth-message-nonces.js'

describe('Message Box durable HTTP authentication migration', () => {
  let directory: string
  let databases: Knex[]
  let servers: Server[]

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'messagebox-auth-'))
    databases = [0, 1].map(() =>
      knexFactory({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'shared.sqlite') },
        useNullAsDefault: true,
        pool: { min: 0, max: 1 }
      })
    )
    servers = []
    await databases[0].schema.createTable('messages', table => {
      table.string('messageId').primary()
    })
    await createServiceTables(databases[0])
  })

  afterEach(async () => {
    await Promise.all(
      servers.map(async server => {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error == null ? resolve() : reject(error)))
        )
      })
    )
    await Promise.all(databases.map(async database => await database.destroy()))
    await rm(directory, { recursive: true, force: true })
  })

  async function startReplica(index: number, onRequest: () => void): Promise<string> {
    const app = express()
    app.use(express.json())
    app.use(
      createAuthMiddleware({
        wallet: new CompletedProtoWallet(new PrivateKey(2)),
        sessionManager: new KnexSessionManager(databases[index])
      })
    )
    app.post('/probe', (_request, response) => {
      onRequest()
      response.json({ ok: true })
    })
    const server = createServer(app)
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('repairs initial HTTP authentication and preserves replay rejection across replicas', async () => {
    let served = 0
    const origins = await Promise.all(
      [0, 1].map(async index => await startReplica(index, () => served++))
    )
    const oldPeer = new Peer(
      new CompletedProtoWallet(new PrivateKey(3)),
      new SimplifiedFetchTransport(origins[0])
    )
    await oldPeer.ready
    await expect(oldPeer.getAuthenticatedSession()).rejects.toThrow('HTTP 500')
    expect(served).toBe(0)

    await up(databases[0])
    let requests = 0
    let signedRequest: RequestInit | undefined
    let signedReplica = 0
    const routeAcrossReplicas: typeof fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname
      const replica = requests++ % origins.length
      const request = { ...init, signal: AbortSignal.timeout(5000) }
      if (pathname === '/probe' && new Headers(init?.headers).has('x-bsv-auth-request-id')) {
        signedRequest = request
        signedReplica = replica
      }
      return await fetch(`${origins[replica]}${pathname}`, request)
    }
    const client = new AuthFetch(
      new CompletedProtoWallet(new PrivateKey(4)),
      undefined,
      undefined,
      undefined,
      {},
      routeAcrossReplicas
    )
    const response = await client.fetch(`${origins[0]}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Synthetic authentication probe' })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(served).toBe(1)
    expect(signedRequest).toBeDefined()
    expect(requests).toBeGreaterThanOrEqual(2)
    const replay = await fetch(`${origins[1 - signedReplica]}/probe`, signedRequest)
    expect(replay.status).toBe(401)
    await replay.text()
    expect(served).toBe(1)
    expect(
      Number((await databases[0]('auth_message_nonces').count({ count: '*' }).first())?.count)
    ).toBeGreaterThanOrEqual(2)
    await expect(down(databases[0])).rejects.toThrow('durable replay claims exist')
  })

  it('makes initial-request claims durable and permits rollback only while empty', async () => {
    const migration = '2026-09-24-001-auth-message-nonces'
    const migrationSource = {
      getMigrations: async () => [migration],
      getMigrationName: (name: string) => name,
      getMigration: async () => ({ up, down })
    }
    expect((await databases[0].migrate.latest({ migrationSource }))[1]).toEqual([migration])
    expect((await databases[0].migrate.latest({ migrationSource }))[1]).toEqual([])
    const managers = databases.map(database => new KnexSessionManager(database))
    const identity = new PrivateKey(5).toPublicKey().toString()
    const nonce = Buffer.alloc(48, 1).toString('base64')
    await expect(managers[0].claimInitialRequestNonce(identity, nonce)).resolves.toBe(true)
    await expect(managers[1].claimInitialRequestNonce(identity, nonce)).resolves.toBe(false)
    await expect(down(databases[0])).rejects.toThrow('durable replay claims exist')
    expect(await databases[1]('auth_message_nonces').count({ count: '*' }).first()).toEqual({
      count: 1
    })
    // Only synthetic fixture data is cleared to exercise the empty-schema rollback.
    await databases[0]('auth_message_nonces').delete()
    await down(databases[0])
    await expect(databases[0].schema.hasTable('auth_message_nonces')).resolves.toBe(false)
    await expect(down(databases[0])).resolves.toBeUndefined()
  })
})
