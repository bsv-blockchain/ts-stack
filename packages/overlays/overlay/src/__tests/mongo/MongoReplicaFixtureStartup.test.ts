import { EventEmitter, once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { MongoInstance, MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

test('a real startup port collision recovers all three members without stopping the port owner', async () => {
  const listener = createServer(socket => socket.destroy())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = (listener.address() as AddressInfo).port
  // Fault injection changes only the first free-port probe. Actual mongod must
  // report the bind collision; later probes and all three members remain real.
  const ports = jest
    .spyOn(
      MongoMemoryServer.prototype as unknown as {
        getNewPort: (port?: number) => Promise<number>
      },
      'getNewPort'
    )
    .mockImplementationOnce(async () => port)
  let fixture: MongoReplicaFixture | undefined
  try {
    fixture = await createMongoReplicaFixture()
    expect(ports.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(listener.listening).toBe(true)
    expect((listener.address() as AddressInfo).port).toBe(port)
    expect(fixture.replicaSet.servers).toHaveLength(3)
    const status = await fixture.db.admin().command({ replSetGetStatus: 1 })
    expect(status.members).toHaveLength(3)
    for (const server of fixture.replicaSet.servers) {
      const info = server.instanceInfo
      if (info === undefined) throw new Error('Recovered replica member has no actual instance')
      expect(info.port).not.toBe(port)
      const member = await fixture.connect(
        { directConnection: true },
        `mongodb://127.0.0.1:${info.port}`
      )
      expect((await member.db('admin').command({ ping: 1 })).ok).toBe(1)
    }
  } finally {
    ports.mockRestore()
    try {
      await fixture?.close()
    } finally {
      await new Promise<void>((resolve, reject) => {
        listener.close(error => (error ? reject(error) : resolve()))
      })
    }
  }
}, 120000)

// This unit exercises only failed startup scheduling. The preceding integration
// case retains the genuine MongoDB processes, bind collision and all oracles.
test('pending member starts drain before inherited automatic replica cleanup', async () => {
  let releaseSiblings!: () => void
  let allStarted!: () => void
  const siblings = new Promise<void>(resolve => {
    releaseSiblings = resolve
  })
  const scheduled = new Promise<void>(resolve => {
    allStarted = resolve
  })
  const failure = new Error('Intentional failed startup scheduling unit')
  const starts = jest
    .spyOn(MongoMemoryServer.prototype, 'start')
    .mockRejectedValueOnce(failure)
    .mockImplementation(async () => {
      await siblings
    })
  const stops = jest.spyOn(MongoMemoryReplSet.prototype, 'stop').mockResolvedValue(true)
  type Initialization = {
    initAllServers: () => Promise<void>
    _initServer: (options: { port: number }) => MongoMemoryServer
  }
  const initialize = jest
    .spyOn(
      SequentialMongoFixtureReplicaSet.prototype as unknown as Initialization,
      'initAllServers'
    )
    .mockImplementation(async function (this: MongoMemoryReplSet & Initialization) {
      const members = [0, 1, 2].map(() => this._initServer({ port: 0 }))
      this.servers.push(...members)
      const pending = members.map(server => server.start())
      allStarted()
      await Promise.all(pending)
    })
  const outcome = createMongoReplicaFixture().then(
    () => ({ kind: 'unexpected success' }),
    error => ({ kind: 'failure', error })
  )
  try {
    await scheduled
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(starts).toHaveBeenCalledTimes(3)
    expect(stops).not.toHaveBeenCalled()
    releaseSiblings()
    expect(await outcome).toEqual({ kind: 'failure', error: failure })
    expect(stops).toHaveBeenCalled()
  } finally {
    releaseSiblings()
    await outcome
    initialize.mockRestore()
    starts.mockRestore()
    stops.mockRestore()
  }
})

test('a rejected lower member start retains its automatic shutdown before replica cleanup', async () => {
  let releaseStop!: () => void
  let allStarted!: () => void
  const stopped = new Promise<boolean>(resolve => {
      releaseStop = () => resolve(true)
    }),
    scheduled = new Promise<void>(resolve => {
      allStarted = resolve
    }),
    failure = new Error('Intentional lower member startup scheduling unit'),
    failedInstances = new WeakSet<MongoInstance>()
  let started = 0
  const lowerStops = jest.spyOn(MongoInstance.prototype, 'stop').mockImplementation(function (
      this: MongoInstance
    ) {
      return failedInstances.has(this) ? stopped : Promise.resolve(true)
    }),
    starts = jest.spyOn(MongoInstance.prototype, 'start').mockImplementation(async function (
      this: MongoInstance
    ) {
      started++
      if (started === 1) allStarted()
      if (started === 1) {
        failedInstances.add(this)
        // Exercise the real constructor's automatic asynchronous stop listener.
        EventEmitter.prototype.emit.call(this, 'instanceError', failure)
        throw failure
      }
    }),
    stop = jest.spyOn(MongoMemoryReplSet.prototype, 'stop'),
    outcome = createMongoReplicaFixture().then(
      () => ({ kind: 'unexpected success' }),
      error => ({ kind: 'failure', error })
    )
  try {
    await scheduled
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(starts).toHaveBeenCalledTimes(1)
    expect(lowerStops).toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    releaseStop()
    expect(await outcome).toEqual({ kind: 'failure', error: failure })
    expect(stop).toHaveBeenCalled()
  } finally {
    releaseStop()
    await outcome
    await stopped
    starts.mockRestore()
    lowerStops.mockRestore()
    stop.mockRestore()
  }
})

import { SequentialMongoFixtureReplicaSet } from './MongoReplicaFixture.js'

type Options = NonNullable<
  NonNullable<ConstructorParameters<typeof MongoMemoryServer>[0]>['instance']
>

class ObservedReplicaSet extends SequentialMongoFixtureReplicaSet {
  readonly events: string[] = []
  readonly options: Options[] = []
  readonly startMember: (index: number) => Promise<void>

  constructor(startMember: (index: number) => Promise<void>) {
    super({
      replSet: { count: 3, storageEngine: 'wiredTiger', ip: '127.0.0.1', name: 'fixture-startup' },
      instanceOpts: [{ launchTimeout: 60000 }, { launchTimeout: 60000 }, { launchTimeout: 60000 }]
    })
    this.startMember = startMember
  }

  protected override _initServer(options: Options): MongoMemoryServer {
    const index = this.options.length
    this.options.push(options)
    const server = new MongoMemoryServer({ instance: options })
    server.start = async (forceSamePort?: boolean) => {
      this.events.push(`start:${index}:${String(forceSamePort)}`)
      await this.startMember(index)
      this.events.push(`ready:${index}`)
    }
    return server
  }

  startMembers(): Promise<void> {
    return this.initAllServers()
  }
}

it('does not probe or start the next member before the previous original start resolves', async () => {
  let release!: () => void
  const first = new Promise<void>(resolve => {
    release = resolve
  })
  const fixture = new ObservedReplicaSet(async index => {
    if (index === 0) await first
  })
  const running = fixture.startMembers()
  await Promise.resolve()
  expect(fixture.options).toHaveLength(1)
  expect(fixture.events).toEqual(['start:0:undefined'])
  release()
  await running
  expect(fixture.events).toEqual([
    'start:0:undefined',
    'ready:0',
    'start:1:undefined',
    'ready:1',
    'start:2:undefined',
    'ready:2'
  ])
  expect(fixture.servers).toHaveLength(3)
  for (const options of fixture.options)
    expect(options).toMatchObject({
      launchTimeout: 60000,
      storageEngine: 'wiredTiger',
      ip: '127.0.0.1',
      replSet: 'fixture-startup'
    })
})

it('retains the exact startup failure with no sibling start outstanding or later member allocated', async () => {
  const failure = new Error('Port already in use')
  const fixture = new ObservedReplicaSet(async index => {
    if (index === 1) throw failure
  })
  await expect(fixture.startMembers()).rejects.toBe(failure)
  expect(fixture.options).toHaveLength(2)
  expect(fixture.servers).toHaveLength(2)
  expect(fixture.events).toEqual(['start:0:undefined', 'ready:0', 'start:1:undefined'])
})

it('restarts the same existing members serially with their original force-same-port option', async () => {
  const fixture = new ObservedReplicaSet(async () => {})
  await fixture.startMembers()
  const original = [...fixture.servers]
  fixture.events.length = 0
  await fixture.startMembers()
  expect(fixture.servers).toEqual(original)
  expect(fixture.options).toHaveLength(3)
  expect(fixture.events).toEqual([
    'start:0:true',
    'ready:0',
    'start:1:true',
    'ready:1',
    'start:2:true',
    'ready:2'
  ])
})
