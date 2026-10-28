import { afterEach, expect, it, jest } from '@jest/globals'
import {
  ProposalScheduler,
  type ProposalSchedulerOptions
} from '../src/proposals/ProposalScheduler.js'
import type {
  ProposalMaintenancePage,
  ProposalMaintenanceItem
} from '../src/proposals/ProposalMaintenance.js'
const a = '11'.repeat(32),
  b = '22'.repeat(32)
const hint = (
  proposalId = a,
  state: ProposalMaintenanceItem['state'] = 'finalizing'
): ProposalMaintenanceItem => ({ channelKey: 'local-channel-' + proposalId, proposalId, state })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(options: Partial<ProposalSchedulerOptions> = {}) {
  const page = jest
    .fn<ProposalSchedulerOptions['source']['page']>()
    .mockResolvedValue({ items: [] })
  const expire = jest
    .fn<ProposalSchedulerOptions['service']['expire']>()
    .mockResolvedValue(undefined)
  const reconcile = jest
    .fn<ProposalSchedulerOptions['service']['reconcile']>()
    .mockResolvedValue(undefined)
  const settings: ProposalSchedulerOptions = {
    source: { durability: 'durable', page },
    service: { expire, reconcile },
    ...options
  }
  return { page, expire, reconcile, settings, worker: new ProposalScheduler(settings) }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
afterEach(() => {
  jest.restoreAllMocks()
})

it.each([
  ['pageSize', 0],
  ['pageSize', 257],
  ['pageSize', 1.5],
  ['maximumRecoveries', 0],
  ['maximumRecoveries', 65],
  ['intervalMs', 0],
  ['intervalMs', 60001]
] as const)('rejects invalid %s=%s without starting work', (key, value) => {
  expect(() => fixture({ [key]: value })).toThrow('bound')
})

it('requires a durable source and remains opt-in', async () => {
  const f = fixture()
  expect(f.page).not.toHaveBeenCalled()
  expect(f.expire).not.toHaveBeenCalled()
  expect(f.reconcile).not.toHaveBeenCalled()
  expect(() =>
    fixture({ source: { ...f.settings.source, durability: 'volatile' as never } })
  ).toThrow('durable')
  f.worker.wake()
  expect(f.page).not.toHaveBeenCalled()
  await f.worker.stop()
  f.worker.wake()
  await expect(f.worker.runOnce()).rejects.toMatchObject({
    code: 'cancelled',
    message: 'Proposal scheduling stopped'
  })
  await expect(f.worker.start(() => {})).rejects.toMatchObject({
    code: 'cancelled',
    message: 'Proposal scheduling stopped'
  })
})

it('keeps expiry moving while deduplicated recovery calls retain every physical slot', async () => {
  const f = fixture({ maximumRecoveries: 2 }),
    first = deferred<void>(),
    second = deferred<void>()
  f.page.mockResolvedValue({ items: [hint(), hint(), hint(b), hint('33'.repeat(32), 'active')] })
  f.reconcile.mockImplementation(id => (id === a ? first.promise : second.promise))
  const initial = await f.worker.runOnce()
  expect(initial).toMatchObject({
    scanned: 4,
    expiryChecks: 1,
    recoveriesStarted: 2,
    retainedJobs: 2,
    failures: []
  })
  expect(f.reconcile.mock.calls).toEqual([[a], [b]])
  expect((await f.worker.runOnce()).recoveriesStarted).toBe(0)
  expect(f.expire).toHaveBeenCalledTimes(2)
  let stopped = false
  const draining = f.worker.stop().then(report => {
    stopped = true
    return report
  })
  await tick()
  expect(stopped).toBe(false)
  first.resolve()
  const failure = new Error('admission outcome still unresolved')
  second.reject(failure)
  expect(await draining).toMatchObject({
    recoveryCallsCompleted: 1,
    retainedJobs: 0,
    failures: [{ key: b, phase: 'recovery', error: failure }]
  })
  expect(f.reconcile).toHaveBeenCalledTimes(2)
})

it('collects settled work on the next valid pass and preserves failures if inventory is unavailable', async () => {
  const f = fixture(),
    failure = new Error('recovery failed'),
    inventory = new Error('inventory failed')
  f.page.mockResolvedValue({ items: [hint()] })
  f.reconcile.mockRejectedValue(failure)
  await f.worker.runOnce()
  await tick()
  f.page.mockRejectedValueOnce(inventory)
  await expect(f.worker.runOnce()).rejects.toBe(inventory)
  f.page.mockResolvedValue({ items: [] })
  expect(await f.worker.runOnce()).toMatchObject({
    failures: [{ key: a, phase: 'recovery', error: failure }],
    retainedJobs: 0
  })
  expect((await f.worker.runOnce()).failures).toEqual([])
  await f.worker.stop()
})

it('coalesces concurrent scans and owns validated work hints before asynchronous expiry', async () => {
  const f = fixture(),
    source = deferred<ProposalMaintenancePage>(),
    expiry = deferred<void>()
  f.page.mockReturnValue(source.promise)
  f.expire.mockReturnValue(expiry.promise)
  const first = f.worker.runOnce(),
    second = f.worker.runOnce()
  expect(f.page).toHaveBeenCalledTimes(1)
  const items = [hint(a, 'active'), hint(b)]
  const page = { items, next: 'next-pass-page' }
  source.resolve(page)
  await tick()
  items[1].proposalId = 'ff'.repeat(32)
  page.next = 'mutated-continuation'
  expiry.resolve()
  const report = await first
  expect(await second).toBe(report)
  await tick()
  expect(f.reconcile).toHaveBeenCalledWith(b)
  f.page.mockResolvedValue({ items: [] })
  await f.worker.runOnce()
  expect(f.page.mock.calls.at(-1)).toEqual([64, 'next-pass-page'])
  await f.worker.stop()
})

it.each([
  { items: [hint(a, 'active'), { ...hint(b), extra: true }] },
  { items: [hint()], next: '' },
  { items: [hint()], extra: true },
  { items: [{ ...hint(), state: 'finalized' }] },
  { items: [{ ...hint(), proposalId: 'bad' }] },
  { items: [{ ...hint(), channelKey: '' }] }
])('validates the whole maintenance page before any service effect', async page => {
  const f = fixture()
  f.page.mockResolvedValue(page as never)
  await expect(f.worker.runOnce()).rejects.toThrow()
  expect(f.expire).not.toHaveBeenCalled()
  expect(f.reconcile).not.toHaveBeenCalled()
  await f.worker.stop()
})

it('rejects an oversized page and a cursor that makes no progress', async () => {
  const f = fixture({ pageSize: 1 })
  f.page.mockResolvedValueOnce({ items: [hint(), hint(b)] })
  await expect(f.worker.runOnce()).rejects.toThrow('page')
  f.page.mockResolvedValue({ items: [], next: 'same' })
  await f.worker.runOnce()
  await expect(f.worker.runOnce()).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Proposal maintenance continuation did not advance'
  })
  await f.worker.stop()
})

it('reports expiry failures without preventing another independent item', async () => {
  const f = fixture(),
    failure = new Error('expiry race')
  f.page.mockResolvedValue({ items: [hint(a, 'active'), hint(b, 'active')] })
  f.expire.mockRejectedValueOnce(failure)
  expect(await f.worker.runOnce()).toMatchObject({
    expiryChecks: 1,
    failures: [{ key: 'local-channel-' + a, phase: 'expiry', error: failure }]
  })
  await f.worker.stop()
})

it('coalesces wake hints during a pass and exposes observer failure without closing dependencies', async () => {
  const f = fixture({ intervalMs: 60000 }),
    failure = new Error('observer stopped'),
    reports: unknown[] = []
  const lifetime = f.worker.start(report => {
    reports.push(report)
    if (reports.length === 1) {
      f.worker.wake()
      f.worker.wake()
    } else throw failure
  })
  await expect(lifetime).rejects.toBe(failure)
  expect(f.page).toHaveBeenCalledTimes(2)
  await expect(f.worker.runOnce()).rejects.toMatchObject({ code: 'cancelled' })
  await f.worker.stop()
})

it('stops during inventory without dispatching returned jobs and drains that physical scan', async () => {
  const f = fixture(),
    source = deferred<ProposalMaintenancePage>()
  f.page.mockReturnValue(source.promise)
  const scan = f.worker.runOnce()
  let stopped = false
  const stopping = f.worker.stop().then(report => {
    stopped = true
    return report
  })
  await tick()
  expect(stopped).toBe(false)
  source.resolve({ items: [hint(), hint(b, 'active')] })
  expect((await scan).scanned).toBe(0)
  await stopping
  expect(f.reconcile).not.toHaveBeenCalled()
  expect(f.expire).not.toHaveBeenCalled()
})

it('runs periodic scans, wakes promptly, coalesces start and clears the timer on shutdown', async () => {
  jest.useFakeTimers()
  const f = fixture(),
    first = jest.fn<() => void>(),
    second = jest.fn<() => void>()
  const lifetime = f.worker.start(first),
    same = f.worker.start(second)
  try {
    await jest.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(1)
    await jest.advanceTimersByTimeAsync(999)
    expect(f.page).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(f.page).toHaveBeenCalledTimes(2)
    f.worker.wake()
    await jest.advanceTimersByTimeAsync(0)
    expect(f.page).toHaveBeenCalledTimes(3)
    expect(jest.getTimerCount()).toBe(1)
    await f.worker.stop()
    await Promise.all([lifetime, same])
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    await f.worker.stop()
    jest.useRealTimers()
  }
})

it('cancels a queued recovery before invocation when shutdown begins in the same scan', async () => {
  const f = fixture()
  f.page.mockResolvedValue({ items: [hint(), hint(b, 'active')] })
  let stopping: ReturnType<ProposalScheduler['stop']> | undefined
  f.expire.mockImplementation(async () => {
    stopping = f.worker.stop()
  })
  const scanned = await f.worker.runOnce()
  const final = await stopping!
  expect(f.reconcile).not.toHaveBeenCalled()
  expect([...scanned.failures, ...final.failures]).toEqual([
    { key: a, phase: 'recovery', error: expect.objectContaining({ code: 'cancelled' }) }
  ])
  expect(final.retainedJobs).toBe(0)
})

it('owns the installed service and inventory methods and reports synchronous recovery failure', async () => {
  const f = fixture(),
    error = new Error('synchronous recovery failure')
  f.page.mockResolvedValue({ items: [hint()] })
  f.reconcile.mockImplementation(() => {
    throw error
  })
  f.settings.source.page = async () => {
    throw new Error('replaced inventory')
  }
  f.settings.service.reconcile = async () => {
    throw new Error('replaced service')
  }
  const first = await f.worker.runOnce()
  const final = await f.worker.stop()
  expect([...first.failures, ...final.failures]).toEqual([{ key: a, phase: 'recovery', error }])
})

it('accepts a completely full bounded page and drains exactly once across repeated stop calls', async () => {
  const f = fixture({ pageSize: 1 }),
    job = deferred<void>()
  f.page.mockResolvedValue({ items: [hint()] })
  f.reconcile.mockReturnValue(job.promise)
  expect(await f.worker.runOnce()).toMatchObject({
    scanned: 1,
    recoveriesStarted: 1,
    retainedJobs: 1
  })
  const first = f.worker.stop(),
    second = f.worker.stop()
  expect(second).toBe(first)
  job.resolve()
  expect(await first).toMatchObject({ recoveryCallsCompleted: 1, retainedJobs: 0 })
  expect(f.worker.stop()).toBe(first)
  expect(await second).toEqual(await first)
})

it.each([
  [
    { items: [{ ...hint(), channelKey: { length: 1 } }] },
    'invalid',
    'Invalid proposal maintenance channel'
  ],
  [{ items: [{ ...hint(), channelKey: 'é'.repeat(8192) }] }, 'limited', 'Output JSON byte limit'],
  [{ items: [{ ...hint(), state: 'retired' }] }, 'invalid', 'Invalid proposal maintenance state'],
  [
    { items: [hint()], next: { length: 1 } },
    'invalid',
    'Invalid proposal maintenance continuation'
  ],
  [{ items: [hint()], next: 'é'.repeat(16384) }, 'limited', 'Output JSON byte limit']
])(
  'preserves bounded inventory failures without invoking service effects',
  async (page, code, message) => {
    const f = fixture()
    f.page.mockResolvedValue(page as never)
    await expect(f.worker.runOnce()).rejects.toMatchObject({ code, message })
    expect(f.expire).not.toHaveBeenCalled()
    expect(f.reconcile).not.toHaveBeenCalled()
    await f.worker.stop()
  }
)
