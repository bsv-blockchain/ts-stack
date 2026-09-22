import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Monitor } from '../Monitor'
import { WalletMonitorTask } from '../tasks/WalletMonitorTask'
import { genesisHeader } from '../../services/chaintracker/chaintracks/util/blockHeaderUtilities'
import { TaskArcadeSSE } from '../tasks/TaskArcSSE'

class ControlledTask extends WalletMonitorTask {
  constructor(
    monitor: Monitor,
    name: string,
    readonly setup: jest.Mock<Promise<void>, []>,
    readonly shouldRun: jest.Mock<{ run: boolean }, [number]>,
    readonly execute: jest.Mock<Promise<string>, []>
  ) {
    super(monitor, name)
  }

  override async asyncSetup(): Promise<void> {
    await this.setup()
  }

  override trigger(now: number): { run: boolean } {
    return this.shouldRun(now)
  }

  override async runTask(): Promise<string> {
    return await this.execute()
  }
}

function createMonitor(): {
  monitor: Monitor
  events: Array<{ event: string; details?: string }>
  setProvider: (value: boolean) => void
} {
  let provider = true
  const events: Array<{ event: string; details?: string }> = []
  const storage = {
    getActive: () => ({ isStorageProvider: () => provider }),
    runAsStorageProvider: async (
      callback: (storageProvider: {
        insertMonitorEvent: (event: { event: string; details?: string }) => Promise<void>
      }) => Promise<void>
    ) => {
      await callback({
        insertMonitorEvent: async event => {
          events.push({ event: event.event, details: event.details })
        }
      })
    }
  }
  const monitor = new Monitor({
    chain: 'main',
    services: { chain: 'main' },
    storage,
    chaintracks: {},
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 0,
    unprovenAttemptsLimitTest: 0,
    unprovenAttemptsLimitMain: 0,
    maxRebroadcastAttempts: 0
  } as any)
  return {
    monitor,
    events,
    setProvider: value => {
      provider = value
    }
  }
}

describe('Monitor.runOnce compatibility', () => {
  const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {})

  afterAll(() => {
    consoleLog.mockRestore()
  })

  it('sets tasks up once, runs ready tasks in order, and records their full logs', async () => {
    const { monitor, events } = createMonitor()
    const setup = jest.fn(async () => {})
    const shouldRun = jest.fn(() => ({ run: true }))
    const execute = jest.fn(async () => 'completed maintenance')
    const task = new ControlledTask(monitor, 'Maintenance', setup, shouldRun, execute)
    monitor.addTask(task)

    await monitor.runOnce()
    await monitor.runOnce()

    expect(setup).toHaveBeenCalledTimes(1)
    expect(shouldRun).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      { event: 'Maintenance', details: 'completed maintenance' },
      { event: 'Maintenance', details: 'completed maintenance' }
    ])
    expect(task.lastRunMsecsSinceEpoch).toBeGreaterThan(0)
  })

  it('sets up every task during a standalone runOnce call', async () => {
    const { monitor } = createMonitor()
    const tasks = ['First', 'Second'].map(
      name =>
        new ControlledTask(
          monitor,
          name,
          jest.fn(async () => {}),
          jest.fn(() => ({ run: false })),
          jest.fn(async () => '')
        )
    )
    for (const task of tasks) monitor.addTask(task)

    await monitor.runOnce()

    expect(tasks[0].setup).toHaveBeenCalledTimes(1)
    expect(tasks[1].setup).toHaveBeenCalledTimes(1)
  })

  it('rejects unsafe custom task names and bounds persisted monitor events', async () => {
    const { monitor, events } = createMonitor()
    const invalid = new ControlledTask(
      monitor,
      'forged\nname',
      jest.fn(async () => {}),
      jest.fn(() => ({ run: false })),
      jest.fn(async () => '')
    )
    expect(() => monitor.addTask(invalid)).toThrow('task.name')
    await expect(monitor.logEvent('forged\nname', 'details')).rejects.toThrow('event')
    await monitor.logEvent('SafeEvent', `line one\n${'x'.repeat(10_000)}`)
    expect(events[0].details).not.toContain('\n')
    expect(events[0].details!.length).toBeLessThanOrEqual(8192)
  })

  it('does not evaluate triggers or run work for a non-provider', async () => {
    const { monitor, setProvider } = createMonitor()
    const task = new ControlledTask(
      monitor,
      'Inactive',
      jest.fn(async () => {}),
      jest.fn(() => ({ run: true })),
      jest.fn(async () => 'must not run')
    )
    monitor.addTask(task)
    setProvider(false)

    await monitor.runOnce()

    expect(task.setup).toHaveBeenCalledTimes(1)
    expect(task.shouldRun).not.toHaveBeenCalled()
    expect(task.execute).not.toHaveBeenCalled()
  })

  it('starts prepared-proof invalidation immediately when a reorg is received', async () => {
    let releaseInvalidation!: () => void
    const pending = new Promise<void>(resolve => {
      releaseInvalidation = resolve
    })
    const invalidatePreparedBeefsForReorg = jest.fn(() => pending)
    const monitor = new Monitor({
      chain: 'main',
      services: { chain: 'main' },
      storage: { invalidatePreparedBeefsForReorg },
      chaintracks: {},
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 0,
      abandonedMsecs: 0,
      unprovenAttemptsLimitTest: 0,
      unprovenAttemptsLimitMain: 0,
      maxRebroadcastAttempts: 0
    } as any)
    const oldTip = { ...genesisHeader('main'), height: 10 }
    const newTip = { ...genesisHeader('main'), height: 11 }
    const deactivated = [{ ...oldTip }]

    monitor.processReorg(1, oldTip, newTip, deactivated)

    expect(invalidatePreparedBeefsForReorg).toHaveBeenCalledTimes(1)
    expect(monitor.deactivatedHeaders).toHaveLength(1)
    releaseInvalidation()
    await monitor.reorgInvalidationPromise
  })

  it('starts reorg invalidation without waiting and records sync and async failures', async () => {
    const source = readFileSync(join(__dirname, '../Monitor.ts'), 'utf8')
    const method = source.slice(source.indexOf('private requestPreparedBeefInvalidation'))
    expect(method).not.toContain('invalidatePreparedBeefsForReorg()')
    expect(method).toContain('preparedBeefInvalidation()')

    const events: Array<{ event: string; details?: string }> = []
    const invalidatePreparedBeefsForReorg = jest.fn(() => {
      throw new Error('sync-invalidation')
    })
    const monitor = new Monitor({
      chain: 'main',
      services: { chain: 'main' },
      storage: {
        invalidatePreparedBeefsForReorg,
        runAsStorageProvider: async (
          callback: (storageProvider: {
            insertMonitorEvent: (event: { event: string; details?: string }) => Promise<void>
          }) => Promise<void>
        ) => {
          await callback({
            insertMonitorEvent: async event => {
              events.push({ event: event.event, details: event.details })
            }
          })
        }
      },
      chaintracks: {},
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 0,
      abandonedMsecs: 0,
      unprovenAttemptsLimitTest: 0,
      unprovenAttemptsLimitMain: 0,
      maxRebroadcastAttempts: 0
    } as any)
    const oldTip = { ...genesisHeader('main'), height: 10 }
    const newTip = { ...genesisHeader('main'), height: 11 }
    const deactivated = [{ ...oldTip }]

    expect(() => monitor.processReorg(1, oldTip, newTip, deactivated)).not.toThrow()
    await monitor.reorgInvalidationPromise
    expect(invalidatePreparedBeefsForReorg).toHaveBeenCalledTimes(1)
    expect(events.map(event => event.event)).toContain('error1')

    invalidatePreparedBeefsForReorg.mockImplementation(() => Promise.reject(new Error('async-invalidation')))
    monitor.processReorg(1, oldTip, newTip, deactivated)
    await monitor.reorgInvalidationPromise
    expect(invalidatePreparedBeefsForReorg).toHaveBeenCalledTimes(2)
    expect(events.filter(event => event.event === 'error1').length).toBeGreaterThanOrEqual(2)

    let released = false
    let releaseInvalidation!: () => void
    const pending = new Promise<void>(resolve => {
      releaseInvalidation = () => {
        released = true
        resolve()
      }
    })
    invalidatePreparedBeefsForReorg.mockImplementation(() => pending)
    monitor.processReorg(1, oldTip, newTip, deactivated)
    expect(invalidatePreparedBeefsForReorg).toHaveBeenCalledTimes(3)
    expect(released).toBe(false)
    releaseInvalidation()
    await monitor.reorgInvalidationPromise
  })

  it('validates, deduplicates, bounds, and copy-isolates reorg work', async () => {
    const invalidatePreparedBeefsForReorg = jest.fn(async () => {})
    const monitor = new Monitor({
      chain: 'main',
      services: { chain: 'main' },
      storage: { invalidatePreparedBeefsForReorg },
      chaintracks: {},
      maxQueuedDeactivatedHeaders: 1,
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 0,
      abandonedMsecs: 0,
      unprovenAttemptsLimitTest: 0,
      unprovenAttemptsLimitMain: 0,
      maxRebroadcastAttempts: 0
    } as any)
    const first = { ...genesisHeader('main'), height: 10 }
    const second = { ...genesisHeader('test'), height: 11 }

    monitor.processReorg(1, first, second, [first])
    monitor.processReorg(1, first, second, [first])
    first.height = 999
    expect(monitor.deactivatedHeaders).toHaveLength(1)
    expect(monitor.deactivatedHeaders[0].header.height).toBe(10)
    expect(invalidatePreparedBeefsForReorg).toHaveBeenCalledTimes(1)

    monitor.enqueueDeactivatedHeader({ whenMsecs: Date.now(), tries: 0, header: second })
    expect(monitor.deactivatedHeaders).toHaveLength(1)
    expect(monitor.deactivatedHeaders[0].header.hash).toBe(second.hash)

    expect(() => monitor.processReorg(0, first, second, [])).toThrow('depth')
    expect(() => monitor.processReorg(1, second, first, [first])).toThrow('old tip')
    expect(() =>
      monitor.processReorg(
        1,
        second,
        first,
        Array.from({ length: 2 }, () => second)
      )
    ).toThrow('deactivatedHeaders')
    await monitor.reorgInvalidationPromise
  })

  it('cleans up a partial event subscription when monitor initialization fails', async () => {
    const unsubscribe = jest.fn(async () => true)
    const eventSource = {
      getChain: jest.fn(async () => 'main'),
      subscribeReorgs: jest.fn(async () => 'reorg-1'),
      subscribeHeaders: jest
        .fn()
        .mockRejectedValueOnce(new Error('header subscription failed'))
        .mockResolvedValue('header-2'),
      unsubscribe
    }
    const monitor = new Monitor({
      chain: 'main',
      services: { chain: 'main' },
      storage: {},
      chaintracks: {},
      chaintracksWithEvents: eventSource,
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 0,
      abandonedMsecs: 0,
      unprovenAttemptsLimitTest: 0,
      unprovenAttemptsLimitMain: 0,
      maxRebroadcastAttempts: 0
    } as any)

    await expect(monitor.ready).rejects.toThrow('header subscription failed')
    expect(unsubscribe).toHaveBeenCalledWith('reorg-1')
    await expect(monitor.ready).resolves.toBeUndefined()
    expect(eventSource.subscribeReorgs).toHaveBeenCalledTimes(2)
    await monitor.destroy()
    expect(unsubscribe).toHaveBeenCalledWith('header-2')
  })

  it('closes Arcade SSE tasks during monitor destruction', async () => {
    const { monitor } = createMonitor()
    const task = new TaskArcadeSSE(monitor)
    const close = jest.fn()
    task.sseClient = { close } as any
    monitor.addTask(task)

    await monitor.destroy()

    expect(close).toHaveBeenCalledTimes(1)
    expect(task.sseClient).toBeNull()
  })

  it('isolates setup and trigger errors while continuing other tasks', async () => {
    const { monitor, events } = createMonitor()
    const setupFailure = new ControlledTask(
      monitor,
      'SetupFailure',
      jest.fn(async () => {
        throw new Error('setup failed')
      }),
      jest.fn(() => ({ run: false })),
      jest.fn(async () => '')
    )
    const triggerFailure = new ControlledTask(
      monitor,
      'TriggerFailure',
      jest.fn(async () => {}),
      jest.fn(() => {
        throw new Error('trigger failed')
      }),
      jest.fn(async () => '')
    )
    monitor.addTask(setupFailure)
    monitor.addTask(triggerFailure)

    await monitor.runOnce()

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ event: 'error0' })
    expect(events[0].details).toContain('SetupFailure asyncSetup error')
    expect(events[1]).toMatchObject({ event: 'error0' })
    expect(events[1].details).toContain('TriggerFailure trigger error')
  })

  it('records run failures with a stack and preserves call-history log redaction', async () => {
    const { monitor, events } = createMonitor()
    monitor.addTask(
      new ControlledTask(
        monitor,
        'Failure',
        jest.fn(async () => {}),
        jest.fn(() => ({ run: true })),
        jest.fn(async () => {
          throw new Error('run failed')
        })
      )
    )
    monitor.addTask(
      new ControlledTask(
        monitor,
        'MonitorCallHistory',
        jest.fn(async () => {}),
        jest.fn(() => ({ run: true })),
        jest.fn(async () => 'sensitive history')
      )
    )

    await monitor.runOnce()

    expect(events[0]).toMatchObject({ event: 'error1' })
    expect(events[0].details).toContain('Failure runTask error')
    expect(events[0].details).not.toContain('\n')
    expect(events[0].details!.length).toBeLessThanOrEqual(8192)
    expect(events[1]).toEqual({
      event: 'MonitorCallHistory',
      details: 'sensitive history'
    })
    expect(consoleLog).not.toHaveBeenCalledWith('TaskMonitorCallHistory ...')
  })

  it('rechecks provider status before each scheduled task', async () => {
    const { monitor, setProvider } = createMonitor()
    const task = new ControlledTask(
      monitor,
      'ProviderChanged',
      jest.fn(async () => {}),
      jest.fn(() => {
        setProvider(false)
        return { run: true }
      }),
      jest.fn(async () => 'must not run')
    )
    monitor.addTask(task)

    await monitor.runOnce()

    expect(task.execute).not.toHaveBeenCalled()
    expect(task.lastRunMsecsSinceEpoch).toBeGreaterThan(0)
  })
})
