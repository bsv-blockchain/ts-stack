import { Monitor } from '../Monitor'
import { WalletMonitorTask } from '../tasks/WalletMonitorTask'

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
    expect(events[0].details).toContain('\n')
    expect(events[1]).toEqual({
      event: 'MonitorCallHistory',
      details: 'sensitive history'
    })
    expect(consoleLog).toHaveBeenCalledWith('TaskMonitorCallHistory ...')
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
