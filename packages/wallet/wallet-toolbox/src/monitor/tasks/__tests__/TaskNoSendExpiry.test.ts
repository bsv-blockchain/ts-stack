import { processNoSendExpiryLifecycle } from '../../../storage/methods/noSendExpiryLifecycle'
import { TaskNoSendExpiry } from '../TaskNoSendExpiry'

jest.mock('../../../storage/methods/noSendExpiryLifecycle', () => ({
  processNoSendExpiryLifecycle: jest.fn()
}))

const lifecycle = processNoSendExpiryLifecycle as jest.MockedFunction<typeof processNoSendExpiryLifecycle>

function makeTask(active = true, triggerMsecs = 10) {
  const provider = { name: 'provider' }
  const storage = {
    isActiveStorageProvider: jest.fn(() => active),
    runAsStorageProvider: jest.fn(async callback => await callback(provider))
  }
  return {
    provider,
    storage,
    task: new TaskNoSendExpiry({ storage } as any, triggerMsecs)
  }
}

describe('TaskNoSendExpiry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(TaskNoSendExpiry as any).checkNow = false
  })

  test('supports interval and explicit lifecycle triggers', () => {
    const { task } = makeTask(true, 10)
    task.lastRunMsecsSinceEpoch = 100

    expect(task.trigger(105)).toEqual({ run: false })
    expect(task.trigger(111)).toEqual({ run: true })

    const disabled = makeTask(true, 0).task
    expect(disabled.trigger(1_000)).toEqual({ run: false })

    const defaultInterval = new TaskNoSendExpiry({ storage: makeTask().storage } as any)
    expect(defaultInterval.trigger(5 * 1_000 + 1)).toEqual({ run: true })

    TaskNoSendExpiry.requestCheck()
    expect(disabled.trigger(1_000)).toEqual({ run: true })
  })

  test('does not execute lifecycle work for a non-authoritative provider', async () => {
    const { task, storage } = makeTask(false)

    await expect(task.runTask()).resolves.toBe('')
    expect(storage.runAsStorageProvider).not.toHaveBeenCalled()
    expect(lifecycle).not.toHaveBeenCalled()
  })

  test('runs keylessly on the active provider and reports only inspected work', async () => {
    const first = makeTask()
    lifecycle.mockResolvedValueOnce({
      inspected: 0,
      cancelled: 0,
      observed: 0,
      reclaimActivated: 0,
      reclaimed: 0,
      targetWon: 0,
      deferred: 0,
      errors: 0
    })
    TaskNoSendExpiry.requestCheck()
    await expect(first.task.runTask()).resolves.toBe('')
    expect(first.task.trigger(0)).toEqual({ run: false })
    expect(lifecycle).toHaveBeenCalledWith(first.provider)

    const second = makeTask()
    lifecycle.mockResolvedValueOnce({
      inspected: 7,
      cancelled: 1,
      observed: 2,
      reclaimActivated: 3,
      reclaimed: 4,
      targetWon: 5,
      deferred: 6,
      errors: 1
    })
    await expect(second.task.runTask()).resolves.toBe(
      'BRC-177 inspected=7 cancelled=1 observed=2 activated=3 reclaimed=4 targetWon=5 deferred=6 errors=1\n'
    )
  })
})
