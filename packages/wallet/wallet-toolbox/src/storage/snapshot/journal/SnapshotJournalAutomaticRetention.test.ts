import {
  SnapshotJournalAutomaticRetention,
  snapshotJournalAutomaticRetentionPolicy
} from './SnapshotJournalAutomaticRetention'
import type { SnapshotJournalMaintenanceRequest, SnapshotJournalMaintenanceResult } from './SnapshotJournalMaintenance'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'

const revision = snapshotJournalRevision
const current = {
  epoch: '12345678-1234-4234-9234-123456789012',
  ceiling: revision('1000000'),
  receiptPolicy: { receiptLimit: 128, receiptLifetimeMs: 600000 }
}
const policy = { minimumEvents: 1000, maximumCollectionPages: 1 }
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
function retention(floor = '0'): SnapshotJournalMaintenanceResult {
  return {
    kind: 'retention',
    value: { floor: revision(floor), highWater: revision('1000'), liveReceipts: 0, examined: 0, receiptsRemoved: 0 }
  }
}

test('finite passes retain a keyset as data across floors and discard it after an actual epoch change', async () => {
  const runner = new SnapshotJournalAutomaticRetention(),
    requests: SnapshotJournalMaintenanceRequest[] = []
  let floor = '0'
  const maintain = async (request: SnapshotJournalMaintenanceRequest): Promise<SnapshotJournalMaintenanceResult> => {
    requests.push(request)
    if (request.operation.kind === 'retention') return retention(floor)
    if (request.operation.kind !== 'collect') throw new Error('Unexpected policy operation')
    return {
      kind: 'collect',
      value: {
        examined: 256,
        removed: 0,
        complete: false,
        after: {
          epoch: request.epoch,
          floor: revision(floor),
          stream: request.operation.page.stream,
          key: { tableId: 0, userId: 1, id1: 20, id2: 0, exactText: '' }
        }
      }
    }
  }
  const drain = jest.fn(async () => undefined)
  await runner.run(current, policy, maintain, drain)
  floor = '2'
  await runner.run(current, policy, maintain, drain)
  const second = requests[3].operation
  expect(second.kind).toBe('collect')
  if (second.kind === 'collect')
    expect(second.page.after).toEqual({
      epoch: current.epoch,
      floor: '2',
      stream: 'scope',
      key: { tableId: 0, userId: 1, id1: 20, id2: 0, exactText: '' }
    })
  await runner.run({ ...current, epoch: '12345678-1234-4234-9234-123456789013' }, policy, maintain, drain)
  const third = requests[5].operation
  if (third.kind !== 'collect') throw new Error('Expected collection')
  expect(third.page.after).toBeUndefined()
  expect(third.page.stream).toBe('scope')
  expect(drain).toHaveBeenCalledTimes(6)
})
test('automatic pass waits for actual owner drain and schedules no next operation after cancellation', async () => {
  const runner = new SnapshotJournalAutomaticRetention(),
    entered = gate(),
    released = gate(),
    controller = new AbortController()
  const maintain = jest.fn(async () => retention())
  const pending = runner.run(
    current,
    policy,
    maintain,
    async () => {
      entered.resolve()
      await released.promise
    },
    { signal: controller.signal }
  )
  try {
    await entered.promise
    await expect(runner.run(current, policy, maintain, async () => undefined)).rejects.toThrow('owns a pass')
    const reason = new Error('finite synthetic caller cancellation')
    controller.abort(reason)
    released.resolve()
    await expect(pending).rejects.toBe(reason)
    expect(maintain).toHaveBeenCalledTimes(1)
  } finally {
    released.resolve()
    await pending.catch(() => undefined)
  }
})
test('processing and independent physical-drain failure both remain observable', async () => {
  const failure = new SnapshotResourceLimitError('finite policy refusal'),
    cleanup = new Error('finite cleanup refusal')
  const pending = new SnapshotJournalAutomaticRetention().run(
    current,
    policy,
    async () => {
      throw failure
    },
    async () => {
      throw cleanup
    }
  )
  await expect(pending).rejects.toMatchObject({ errors: [failure, cleanup], cause: failure })
})
test('a completed bounded stream rotates scope and physical scans without retaining pools or timers', async () => {
  const requests: SnapshotJournalMaintenanceRequest[] = []
  await new SnapshotJournalAutomaticRetention().run(
    current,
    { ...policy, maximumCollectionPages: 2 },
    async request => {
      requests.push(request)
      return request.operation.kind === 'retention'
        ? retention()
        : {
            kind: 'collect',
            value: { examined: 2, removed: 1, complete: true }
          }
    },
    async () => undefined
  )
  expect(
    requests.slice(1).map(request => request.operation.kind === 'collect' && request.operation.page.stream)
  ).toEqual(['scope', 'physical'])
})
test('policy detaches caller data and enforces explicit finite collection bounds', () => {
  const selected = { ...policy },
    detached = snapshotJournalAutomaticRetentionPolicy(selected)
  selected.maximumCollectionPages = 99
  expect(detached).toEqual(policy)
  expect(Object.isFrozen(detached)).toBe(true)
  expect(snapshotJournalAutomaticRetentionPolicy(false)).toBe(false)
  for (const value of [-1, NaN, 1.5, Infinity])
    expect(() => snapshotJournalAutomaticRetentionPolicy({ ...policy, minimumEvents: value })).toThrow()
  for (const value of [0, 9, 1.5, Infinity])
    expect(() => snapshotJournalAutomaticRetentionPolicy({ ...policy, maximumCollectionPages: value })).toThrow()
})

test('the whole pass shares one deadline and never renews admission after a physically drained operation', async () => {
  let now = 100000
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
  const entered = gate(),
    released = gate(),
    maintain = jest.fn(async () => {
      now += 5001
      return retention()
    }),
    drain = jest.fn(async () => {
      entered.resolve()
      await released.promise
    })
  const pending = new SnapshotJournalAutomaticRetention().run(current, policy, maintain, drain, { lifetimeMs: 5000 })
  const observed = expect(pending).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  try {
    await entered.promise
    let finished = false
    void pending.then(
      () => {
        finished = true
      },
      () => {
        finished = true
      }
    )
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(maintain).toHaveBeenCalledTimes(1)
    released.resolve()
    await observed
    expect(maintain).toHaveBeenCalledTimes(1)
    expect(drain).toHaveBeenCalledTimes(1)
  } finally {
    released.resolve()
    await pending.catch(() => undefined)
    clock.mockRestore()
  }
})

test('caller options cannot change the next operation signal or renew its fixed deadline', async () => {
  const controller = new AbortController(),
    replaced = new AbortController()
  const options = { lifetimeMs: 5000, signal: controller.signal }
  const lifetimes: number[] = [],
    signals: Array<AbortSignal | undefined> = []
  await new SnapshotJournalAutomaticRetention().run(
    current,
    policy,
    async (request, selected) => {
      lifetimes.push(selected.lifetimeMs!)
      signals.push(selected.signal)
      options.lifetimeMs = 30000
      options.signal = replaced.signal
      return request.operation.kind === 'retention'
        ? retention()
        : { kind: 'collect', value: { examined: 0, removed: 0, complete: true } }
    },
    async () => undefined,
    options
  )
  expect(signals).toEqual([controller.signal, controller.signal])
  expect(lifetimes).toHaveLength(2)
  expect(lifetimes[0]).toBeLessThanOrEqual(5000)
  expect(lifetimes[1]).toBeLessThanOrEqual(lifetimes[0])
})
