import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import type { Wallet } from '../../src/Wallet'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { StorageProvider } from '../../src/storage/StorageProvider'
import { StorageServer, type WalletStorageServerOptions } from '../../src/storage/remoting/StorageServer'
import { seedArchiveClosure } from './snapshotArchiveFixtures'

export function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

export async function snapshotHttpFixture(snapshotSync = true, seedClosure = true) {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-http-'))
  const key = PrivateKey.fromRandom()
  const identityKey = key.toPublicKey().toString()
  const wallet = new ProtoWallet(key)
  const serverKey = PrivateKey.fromRandom()
  const serverWallet = Object.assign(new ProtoWallet(serverKey), { chain: 'test' }) as unknown as Wallet
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    snapshotSync,
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
  })
  const servers: StorageServer[] = []
  const close = async () => {
    await Promise.all(servers.map(server => server.close()))
    await storage.destroy()
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await storage.knex.raw('PRAGMA journal_mode = WAL')
    await storage.migrate('HTTP snapshot source', 'http-snapshot-source')
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identityKey)
    const { user: other } = await storage.findOrInsertUser(PrivateKey.fromRandom().toPublicKey().toString())
    if (seedClosure) await seedArchiveClosure(storage, user.userId, other.userId)
    const serve = async (options: Partial<WalletStorageServerOptions> = {}) => {
      const server = new StorageServer(storage, {
        port: 0,
        host: '127.0.0.1',
        wallet: serverWallet,
        monetize: false,
        logRpcRequests: false,
        ...options
      })
      servers.push(server)
      server.start()
      if (!server.server.listening) await once(server.server, 'listening')
      const address = server.server.address()
      if (address === null || typeof address === 'string') throw new Error('Fixture listener did not bind')
      return { server, url: `http://127.0.0.1:${address.port}` }
    }
    return { storage, identityKey, wallet, serverIdentityKey: serverKey.toPublicKey().toString(), serve, close }
  } catch (error) {
    await close()
    throw error
  }
}
