import { MongoMemoryServer } from 'mongodb-memory-server'
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
