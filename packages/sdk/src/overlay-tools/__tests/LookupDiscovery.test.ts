import { LookupDiscovery } from '../LookupDiscovery.js'
import { LookupResourceLimitError, lookupLimits } from '../LookupResources.js'

const limits = lookupLimits({
  maxHosts: 4,
  maxHostsPerTracker: 2,
  maxTrackers: 4,
  hostConcurrency: 2,
  trackerConcurrency: 1,
  maxResponseBytes: 100,
  maxTotalBytes: 20,
  maxOutputs: 8,
  maxEvidenceOutputs: 8,
  maxEvidenceBytes: 100
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('LookupDiscovery', () => {
  it('rejects further byte charges after the last subscriber abandons discovery', async () => {
    const started = deferred<(bytes: number) => void>()
    const hang = deferred<string[]>()
    const discovery = new LookupDiscovery(
      ['https://tracker.example'],
      limits,
      async (_tracker, _signal, consume) => {
        started.resolve(consume)
        return await hang.promise
      },
      () => {}
    )
    const unsubscribe = discovery.subscribe(() => {})
    const consume = await started.promise
    unsubscribe()

    expect(() => consume(1)).toThrow('Lookup resource limit reached: abandoned')

    hang.resolve([])
  })

  it('charges tracker bytes until maxTotalBytes then records the limit without a tracker failure', async () => {
    const discovery = new LookupDiscovery(
      ['https://tracker.example'],
      limits,
      async (_tracker, _signal, consume) => {
        consume(10)
        consume(11)
        return []
      },
      () => {}
    )
    const finished = deferred<void>()
    discovery.subscribe(state => {
      if (state.done) finished.resolve()
    })
    await finished.promise

    expect(discovery.state.receivedBytes).toBe(10)
    expect(discovery.state.limitsHit.has('maxTotalBytes')).toBe(true)
    expect(discovery.state.trackersFailed).toBe(0)
    expect(discovery.state.trackersCompleted).toBe(1)
  })

  it('skips invalid, duplicate, and over-share hosts from one tracker', async () => {
    const discovery = new LookupDiscovery(
      ['https://tracker.example'],
      limits,
      async () => [
        'not-a-url',
        'ftp://blocked.example',
        'https://user:pass@secret.example',
        'https://host.example',
        'https://host.example/',
        'https://second.example',
        'https://third.example'
      ],
      () => {}
    )
    const finished = deferred<void>()
    discovery.subscribe(state => {
      if (state.done) finished.resolve()
    })
    await finished.promise

    expect(discovery.state.sources.get('https://tracker.example')).toEqual([
      'https://host.example',
      'https://second.example'
    ])
    expect(discovery.state.skippedHosts).toBeGreaterThanOrEqual(3)
    expect(discovery.state.limitsHit.has('maxHostsPerTracker')).toBe(true)
  })

  it('records a resource-limit error from lookup without counting a tracker failure', async () => {
    const discovery = new LookupDiscovery(
      ['https://tracker.example'],
      limits,
      async () => {
        throw new LookupResourceLimitError('maxResponseBytes')
      },
      () => {}
    )
    const finished = deferred<void>()
    discovery.subscribe(state => {
      if (state.done) finished.resolve()
    })
    await finished.promise

    expect(discovery.state.limitsHit.has('maxResponseBytes')).toBe(true)
    expect(discovery.state.trackersFailed).toBe(0)
  })

  it('does not record hosts after the last subscriber abandons an in-flight tracker', async () => {
    const started = deferred<void>()
    const release = deferred<string[]>()
    const discovery = new LookupDiscovery(
      ['https://tracker.example'],
      limits,
      async () => {
        started.resolve()
        return await release.promise
      },
      () => {}
    )
    const unsubscribe = discovery.subscribe(() => {})
    await started.promise
    unsubscribe()
    release.resolve(['https://late-host.example'])
    while (discovery.state.trackersCompleted === 0) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }

    expect(discovery.state.sources.size).toBe(0)
  })
})
