import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { KnexSnapshotArchiveRpc } from '../../src/storage/snapshot/archive/KnexSnapshotArchiveRpc'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import type { Wallet } from '../../src/Wallet'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { StorageProvider } from '../../src/storage/StorageProvider'
import {
  StorageServer,
  type WalletStorageServerOptions
} from '../../src/storage/remoting/StorageServer'
import { seedArchiveClosure } from './snapshotArchiveFixtures'
import { runInSeries } from '../../src/utility/runInSeries'

export function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function closeFixtureArchiveRpc(server: StorageServer): Promise<void> {
  const rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc | undefined
  await rpc?.close()
}
async function closeFixtureListener(server: StorageServer): Promise<void> {
  const listener = server.server as Server | undefined
  if (!listener?.listening) return
  await new Promise<void>((resolve, reject) => {
    listener.close((error?: NodeJS.ErrnoException) => {
      if (error !== undefined && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
  })
}

export async function snapshotHttpFixture(snapshotSync = true, seedClosure = true) {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-http-'))
  const key = PrivateKey.fromRandom()
  const identityKey = key.toPublicKey().toString()
  const wallet = new ProtoWallet(key)
  const serverKey = PrivateKey.fromRandom()
  const serverWallet = Object.assign(new ProtoWallet(serverKey), {
    chain: 'test'
  }) as unknown as Wallet
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
    // Test the public close outcome, but own the actual resources independently.
    // A failed or mutated close must not leak a listener/capture into later tests.
    const draining = servers.flatMap(server => [
      (async () => await server.close())(),
      closeFixtureArchiveRpc(server),
      closeFixtureListener(server)
    ])
    const results = await Promise.allSettled(draining)
    const failures = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason)
    await runInSeries(
      [
        async () => await storage.destroy(),
        async () => await storage.knex.destroy(),
        async () => await rm(directory, { recursive: true, force: true })
      ],
      async cleanup => {
        try {
          await cleanup()
        } catch (error) {
          failures.push(error)
        }
      }
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Snapshot HTTP fixture cleanup failed')
  }
  try {
    await storage.knex.raw('PRAGMA journal_mode = WAL')
    await storage.migrate('HTTP snapshot source', 'http-snapshot-source')
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(identityKey)
    const { user: other } = await storage.findOrInsertUser(
      PrivateKey.fromRandom().toPublicKey().toString()
    )
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
      if (address === null || typeof address === 'string')
        throw new Error('Fixture listener did not bind')
      return { server, url: `http://127.0.0.1:${address.port}` }
    }
    return {
      storage,
      identityKey,
      wallet,
      serverIdentityKey: serverKey.toPublicKey().toString(),
      serve,
      close
    }
  } catch (error) {
    try {
      await close()
    } catch (error_) {
      throw new AggregateError([error, error_], 'Snapshot HTTP fixture setup and cleanup failed')
    }
    throw error
  }
}
