import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient, type Db, type Document, type MongoClientOptions } from 'mongodb'
import { MongoInstance, MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
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

// memory-server 11.2 publishes instanceInfo only after start succeeds. A failed
// lower instance can already own automatic shutdown before then. Retain the
// actual fresh unauthenticated member first, so inherited stop awaits it too.
class FixtureMemoryServer extends MongoMemoryServer {
  override async _startUpInstance(forceSamePort?: boolean): Promise<void> {
    if (this._instanceInfo !== undefined || this.authObjectEnable())
      return await super._startUpInstance(forceSamePort)
    const { mongodOptions, data } = await this.getStartOptions(
        forceSamePort ?? !(this.opts.instance?.portGeneration ?? true)
      ),
      instance = new MongoInstance(mongodOptions)
    if (typeof data.dbPath !== 'string' || data.dbPath.length === 0)
      throw new Error('Mongo fixture startup did not retain its actual database path')
    this._instanceInfo = { ...data, dbPath: data.dbPath, instance }
    await instance.start()
  }
}

// A failed member can reject the replica-set startup before its siblings finish
// starting. Drain those real starts before stopping the owned set or retrying.
class FixtureReplicaSet extends MongoMemoryReplSet {
  private readonly memberStarts: Promise<void>[] = []

  protected override _initServer(options: Parameters<MongoMemoryReplSet['_initServer']>[0]) {
    const server = new FixtureMemoryServer({
      binary: this.binaryOpts,
      instance: options,
      spawn: this.replSetOpts.spawn,
      auth: typeof this.replSetOpts.auth === 'object' ? this.replSetOpts.auth : undefined
    })
    const start = server.start.bind(server)
    server.start = (...args: Parameters<typeof start>) => {
      const pending = start(...args)
      this.memberStarts.push(pending)
      return pending
    }
    return server
  }

  async drainMemberStarts(): Promise<void> {
    await Promise.allSettled(this.memberStarts)
  }
  protected override async initAllServers(): Promise<void> {
    try {
      await super.initAllServers()
    } catch (error) {
      // The inherited start() auto-stops before its rejection reaches our
      // caller. Drain here so that cleanup cannot race a sibling's startup.
      await this.drainMemberStarts()
      throw error
    }
  }
}

async function startReplicaSet(): Promise<MongoMemoryReplSet> {
  const launchDeadline = performance.now() + 60000
  let previousFailure: Error | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = Math.ceil(launchDeadline - performance.now())
    if (remaining <= 0)
      throw previousFailure ?? new Error('Original replica fixture launch deadline elapsed')
    const replicaSet = new FixtureReplicaSet({
      binary: { version: '8.2.6' },
      replSet: {
        name: `s02-${randomUUID()}`,
        count: 3,
        storageEngine: 'wiredTiger',
        ip: '127.0.0.1',
        args: ['--setParameter', 'enableTestCommands=1', '--wiredTigerCacheSizeGB', '0.25'],
        configSettings: { electionTimeoutMillis: 2000, heartbeatIntervalMillis: 500 }
      },
      instanceOpts: Array.from({ length: 3 }, () => ({ launchTimeout: Math.min(60000, remaining) }))
    })
    try {
      await replicaSet.start()
      return replicaSet
    } catch (error) {
      await replicaSet.drainMemberStarts()
      try {
        if (!(await replicaSet.stop())) throw new Error('Owned replica fixture did not stop')
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Replica fixture startup and owned cleanup failed'
        )
      }
      // The free-port probe and mongod's bind cannot be atomic. Retry only that
      // exact startup collision, with fresh members and the original deadline.
      // Never stop the unrelated listener that won the port.
      if (
        !(error instanceof Error) ||
        !/^Port "[1-9][0-9]{0,4}" already in use$/.test(error.message)
      )
        throw error
      previousFailure = error
    }
  }
  throw previousFailure ?? new Error('Original replica fixture launch deadline elapsed')
}

export async function createMongoReplicaFixture(): Promise<MongoReplicaFixture> {
  const appName = `overlay-s02-${randomUUID()}`
  const replicaSet = await startReplicaSet()
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
