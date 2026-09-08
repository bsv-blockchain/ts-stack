import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient, type Db, type Document, type MongoClientOptions } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { StorageScope } from '../../storage/AdmissionStorage.js'

/** Owns only randomly named databases, ports and temporary mongod files. */
export interface MongoReplicaFixture {
  replicaSet: MongoMemoryReplSet
  client: MongoClient
  db: Db
  uri: string
  appName: string
  scope: StorageScope
  connect: (options?: MongoClientOptions, uri?: string) => Promise<MongoClient>
  failCommands: (data: Document, times?: number) => Promise<void>
  disableFailPoint: () => Promise<void>
  stepDown: () => Promise<{ previous: string; current: string }>
  killPrimary: () => Promise<{ previous: string; current: string }>
  close: () => Promise<void>
}

export async function createMongoReplicaFixture(): Promise<MongoReplicaFixture> {
  const appName = `overlay-s02-${randomUUID()}`
  const replicaSet = new MongoMemoryReplSet({
    binary: { version: '8.2.6' },
    replSet: {
      name: `s02-${randomUUID()}`,
      count: 3,
      storageEngine: 'wiredTiger',
      ip: '127.0.0.1',
      args: [
        '--setParameter',
        'enableTestCommands=1',
        '--wiredTigerCacheSizeGB',
        '0.25'
      ],
      configSettings: { electionTimeoutMillis: 2000, heartbeatIntervalMillis: 500 }
    },
    instanceOpts: [{ launchTimeout: 60000 }, { launchTimeout: 60000 }, { launchTimeout: 60000 }]
  })
  try {
    await replicaSet.start()
  } catch (error) {
    await replicaSet.stop()
    throw error
  }
  const uri = replicaSet.getUri()
  const clients: MongoClient[] = []
  const connect = async (options: MongoClientOptions = {}, connectionUri = uri) => {
    const client = new MongoClient(connectionUri, {
      appName,
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 5000,
      heartbeatFrequencyMS: 500,
      maxPoolSize: 8,
      writeConcern: { w: 'majority', j: true },
      ...options
    })
    clients.push(client)
    await client.connect()
    return client
  }
  let client: MongoClient
  try {
    client = await connect()
  } catch (error) {
    await Promise.allSettled(clients.map(item => item.close()))
    await replicaSet.stop()
    throw error
  }
  const db = client.db(`overlay_s02_${randomUUID().replaceAll('-', '')}`)
  const primary = async (): Promise<string> => {
    const hello = await db.admin().command({ hello: 1 }, { timeoutMS: 15000 })
    if (typeof hello.primary !== 'string') throw new Error('Replica fixture has no primary')
    return hello.primary
  }
  const waitForNewPrimary = async (previous: string): Promise<string> => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      try {
        const current = await primary()
        if (current !== previous) return current
      } catch {
        // Election temporarily has no writable primary; the loop has a finite deadline.
      }
      await delay(100)
    }
    throw new Error('Replica fixture primary election timed out')
  }
  return {
    replicaSet,
    client,
    db,
    uri,
    appName,
    scope: { network: 'testnet', genesisHash: '11'.repeat(32), nodeId: 's02-node-a' },
    connect,
    async failCommands(data, times = 1) {
      await db.admin().command({
        configureFailPoint: 'failCommand',
        mode: { times },
        data: { appName, ...data }
      })
    },
    async disableFailPoint() {
      await db.admin().command({ configureFailPoint: 'failCommand', mode: 'off' })
    },
    async stepDown() {
      const previous = await primary()
      const admin = await connect(
        { appName: `${appName}-control`, directConnection: true },
        `mongodb://${previous}`
      )
      try {
        await admin.db('admin').command({ replSetStepDown: 10, force: true }, { timeoutMS: 15000 })
      } finally {
        await admin.close()
      }
      return { previous, current: await waitForNewPrimary(previous) }
    },
    async killPrimary() {
      const previous = await primary()
      const port = Number(previous.slice(previous.lastIndexOf(':') + 1))
      const server = replicaSet.servers.find(item => item.instanceInfo?.port === port)
      const child = server?.instanceInfo?.instance.mongodProcess
      if (child === undefined || child === null) {
        throw new Error('Could not kill this fixture primary process')
      }
      const exited = once(child, 'close', { signal: AbortSignal.timeout(5000) })
      if (!child.kill('SIGKILL')) throw new Error('Could not kill this fixture primary process')
      await exited
      // memory-server 11.2 leaves this public handle set for an externally
      // killed process; clear it only after observing that owned child's exit.
      const instance = server?.instanceInfo?.instance
      if (instance !== undefined) instance.mongodProcess = undefined
      await server?.stop({ doCleanup: false })
      return { previous, current: await waitForNewPrimary(previous) }
    },
    async close() {
      await Promise.allSettled(clients.map(item => item.close()))
      await replicaSet.stop()
    }
  }
}
