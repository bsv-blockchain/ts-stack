import { runSnapshotSyncSession } from './runSnapshotSyncSession'
import type { WalletReadSnapshot, WalletSnapshotCursor } from './WalletReadSnapshot'
import type { SnapshotSyncCheckpoint, SnapshotSyncCommit, SnapshotSyncStorage } from './SnapshotSync'
import type { SyncSessionOptions, SyncSessionProgress } from '../sync/syncSession'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import { SyncPageBudget } from '../sync/SyncPageBudget'

function session() {
  const checkpoint: SnapshotSyncCheckpoint = {
    version: 1,
    sessionId: 'a'.repeat(64),
    snapshotId: 'b'.repeat(64),
    identityKey: 'identity',
    sourceStorageIdentityKey: 'source',
    destinationStorageIdentityKey: 'destination',
    tableIndex: 11,
    sequence: 11,
    done: false,
    cursor: { version: 1, snapshotId: 'b'.repeat(64), table: 'provenTxReqs', after: [7] }
  }
  const view = {
    isOpen: true,
    expiresAt: Date.now() + 10000,
    closed: Promise.resolve(),
    readPage: jest.fn(async () => ({ rows: [], payloadBytes: 0, done: true }))
  } as unknown as WalletReadSnapshot
  const apply = jest.fn(async (): Promise<SnapshotSyncCommit> => ({
    checkpoint: { ...checkpoint, cursor: undefined, sequence: 12, tableIndex: 12, done: true },
    inserts: 2,
    updates: 3
  }))
  const destination = {
    begin: jest.fn(async () => checkpoint),
    prepare: jest.fn(async () => apply)
  } as unknown as SnapshotSyncStorage
  const ownership = { commit: async <T>(work: () => Promise<T>): Promise<T> => await work() }
  const commit = jest.spyOn(ownership, 'commit')
  return {
    input: { view, destination, commit: ownership.commit, activeStorage: 'source' },
    checkpoint,
    view,
    destination,
    apply,
    commit
  }
}

test.each([
  { maxItems: 0 },
  { maxItems: -1 },
  { maxItems: 1.5 },
  { maxItems: 1001 },
  { maxItems: NaN },
  { maxRoughSize: 0 },
  { maxRoughSize: -1 },
  { maxRoughSize: 1.5 },
  { maxRoughSize: 10000001 },
  { maxRoughSize: Infinity }
])('rejects invalid limits before opening destination state: %j', async options => {
  const f = session()
  await expect(runSnapshotSyncSession(f.input, options)).rejects.toThrow('limits')
  expect(f.commit).not.toHaveBeenCalled()
})

test('progress uses detached checkpoints and reports the committed counts and timings', async () => {
  const f = session()
  Reflect.set(f.checkpoint.cursor!, 'archivePosition', {
    version: 1,
    archiveId: 'c'.repeat(64),
    sequence: 12,
    rowOffset: 7
  })
  const states: SyncSessionProgress['state'][] = []
  const result = await runSnapshotSyncSession(f.input, {
    maxItems: 17,
    maxRoughSize: 2048,
    onProgress: progress => {
      states.push(progress.state)
      if (progress.snapshotCheckpoint?.cursor) Reflect.set(progress.snapshotCheckpoint.cursor.after, '0', 999)
      if (progress.snapshotCheckpoint?.cursor?.archivePosition)
        Reflect.set(progress.snapshotCheckpoint.cursor.archivePosition, 'rowOffset', 999)
      if (progress.snapshotCheckpoint) progress.snapshotCheckpoint.identityKey = 'changed-by-listener'
      if (progress.state === 'committed') {
        expect(progress).toMatchObject({ pages: 1, inserts: 2, updates: 3 })
        for (const value of [progress.readMs, progress.prepareMs, progress.commitMs, progress.queueMs])
          expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })
  expect(states).toEqual(['reading', 'preparing', 'committing', 'committed', 'completed'])
  expect(f.view.readPage).toHaveBeenCalledWith('provenTxReqs', f.checkpoint.cursor, {
    maxRows: expect.any(Number),
    maxBytes: 2048
  })
  const limits = (f.view.readPage as jest.Mock).mock.calls[0][2]
  expect(limits.maxRows).toBeGreaterThanOrEqual(1)
  expect(limits.maxRows).toBeLessThanOrEqual(17)
  expect(f.checkpoint.cursor!.after).toEqual([7])
  expect(f.checkpoint.cursor!.archivePosition!.rowOffset).toBe(7)
  expect(result).toMatchObject({
    status: 'completed',
    mode: 'paged',
    pages: 1,
    inserts: 2,
    updates: 3,
    snapshotCheckpoint: { done: true, identityKey: 'identity' }
  })
  expect(f.commit).toHaveBeenCalledTimes(2)
})

test.each([
  'before-start',
  'queued-start',
  'after-start',
  'reading',
  'after-read',
  'preparing',
  'after-prepare',
  'committing',
  'committed'
])('cancellation at %s reports the durable outcome and stops the next write', async boundary => {
  const f = session()
  const controller = new AbortController()
  const states: string[] = []
  if (boundary === 'before-start') controller.abort()
  if (boundary === 'queued-start')
    f.commit.mockImplementationOnce(async work => {
      controller.abort()
      return await work()
    })
  if (boundary === 'after-start')
    (f.destination.begin as jest.Mock).mockImplementationOnce(async () => {
      controller.abort()
      return f.checkpoint
    })
  if (boundary === 'after-read')
    (f.view.readPage as jest.Mock).mockImplementationOnce(async () => {
      controller.abort()
      return { rows: [], payloadBytes: 0, done: true }
    })
  if (boundary === 'after-prepare')
    (f.destination.prepare as jest.Mock).mockImplementationOnce(async () => {
      controller.abort()
      return f.apply
    })
  const result = await runSnapshotSyncSession(f.input, {
    signal: controller.signal,
    onProgress: progress => {
      states.push(progress.state)
      if (progress.state === boundary) controller.abort()
    }
  })
  const committed = boundary === 'committed'
  expect(result.status).toBe('cancelled')
  expect(result.pages).toBe(Number(committed))
  expect(f.apply).toHaveBeenCalledTimes(Number(committed))
  expect(states.slice(-2)).toEqual(['cancelling', 'cancelled'])
  expect(states).not.toContain('completed')
  expect(f.destination.begin).toHaveBeenCalledTimes(Number(!['before-start', 'queued-start'].includes(boundary)))
  expect(f.view.readPage).toHaveBeenCalledTimes(
    Number(['after-read', 'preparing', 'after-prepare', 'committing', 'committed'].includes(boundary))
  )
  expect(f.destination.prepare).toHaveBeenCalledTimes(
    Number(['after-prepare', 'committing', 'committed'].includes(boundary))
  )
  const stages = ['reading', 'preparing', 'committing', 'committed']
  const stageCount = {
    'before-start': 0,
    'queued-start': 0,
    'after-start': 0,
    reading: 1,
    'after-read': 1,
    preparing: 2,
    'after-prepare': 2,
    committing: 3,
    committed: 4
  }[boundary]!
  expect(states).toEqual([...stages.slice(0, stageCount), 'cancelling', 'cancelled'])
})

test.each([
  ['version', 2],
  ['snapshotId', 'another-view'],
  ['table', 'txLabels'],
  ['after', [9]]
])('a changed acknowledged cursor %s cannot become the next read position', async (field, value) => {
  const f = session()
  const cursor = { version: 1 as const, snapshotId: 'b'.repeat(64), table: 'provenTxReqs' as const, after: [8] }
  ;(f.view.readPage as jest.Mock).mockResolvedValue({
    rows: [{ provenTxReqId: 8 }],
    payloadBytes: 128,
    done: false,
    cursor
  })
  f.apply.mockResolvedValue({
    inserts: 1,
    updates: 0,
    checkpoint: { ...f.checkpoint, sequence: 12, cursor: { ...cursor, [field as string]: value } }
  })
  await expect(runSnapshotSyncSession(f.input, {})).rejects.toThrow('acknowledgement does not match')
  expect(f.view.readPage).toHaveBeenCalledTimes(1)
})

test('a nonterminal acknowledgement advances a detached cursor before finishing its table', async () => {
  const f = session()
  const cursor: WalletSnapshotCursor = {
    version: 1,
    snapshotId: 'b'.repeat(64),
    table: 'provenTxReqs',
    after: [8],
    archivePosition: { version: 1, archiveId: 'c'.repeat(64), sequence: 12, rowOffset: 8 }
  }
  ;(f.view.readPage as jest.Mock).mockResolvedValueOnce({
    rows: [{ provenTxReqId: 8 }],
    payloadBytes: 128,
    done: false,
    cursor
  })
  const acknowledged: SnapshotSyncCheckpoint = {
    ...f.checkpoint,
    sequence: 12,
    cursor: { ...cursor, after: [8], archivePosition: { ...cursor.archivePosition! } }
  }
  f.apply.mockResolvedValueOnce({ inserts: 1, updates: 0, checkpoint: acknowledged })
  f.apply.mockResolvedValueOnce({
    inserts: 0,
    updates: 0,
    checkpoint: { ...f.checkpoint, sequence: 13, tableIndex: 12, done: true, cursor: undefined }
  })
  const result = await runSnapshotSyncSession(f.input, {
    onProgress: progress => {
      if (progress.state === 'committed' && progress.pages === 1) {
        Reflect.set(acknowledged.cursor!.after, '0', 999)
        Reflect.set(acknowledged.cursor!.archivePosition!, 'rowOffset', 999)
        acknowledged.sequence = 999
      }
    }
  })
  expect((f.view.readPage as jest.Mock).mock.calls[1][1]).toEqual(cursor)
  expect(result).toMatchObject({ status: 'completed', pages: 2, inserts: 1, updates: 0 })
})

test.each(['omitted', 'archive', 'sequence', 'offset'] as const)(
  'an acknowledgement with %s archive position cannot become the next read position',
  async change => {
    const f = session()
    const position = { version: 1 as const, archiveId: 'c'.repeat(64), sequence: 12, rowOffset: 8 }
    const cursor: WalletSnapshotCursor = {
      version: 1,
      snapshotId: 'b'.repeat(64),
      table: 'provenTxReqs',
      after: [8],
      archivePosition: position
    }
    ;(f.view.readPage as jest.Mock).mockResolvedValue({
      rows: [{ provenTxReqId: 8 }],
      payloadBytes: 128,
      done: false,
      cursor
    })
    const changed = { ...position }
    if (change === 'archive') changed.archiveId = 'd'.repeat(64)
    if (change === 'sequence') changed.sequence++
    if (change === 'offset') changed.rowOffset++
    f.apply.mockResolvedValue({
      inserts: 1,
      updates: 0,
      checkpoint: {
        ...f.checkpoint,
        sequence: 12,
        cursor: { ...cursor, archivePosition: change === 'omitted' ? undefined : changed }
      }
    })
    await expect(runSnapshotSyncSession(f.input, {})).rejects.toThrow('acknowledgement does not match')
    expect(f.view.readPage).toHaveBeenCalledTimes(1)
  }
)

test.each(['closed', 'expired', 'cleanup-failed'] as const)(
  'source %s while queued prevents a destination write',
  async outcome => {
    const f = session()
    const cleanup = new Error('physical cleanup failed')
    const options: SyncSessionOptions = {
      onProgress: progress => {
        if (progress.state !== 'committing') return
        Object.defineProperty(f.view, 'isOpen', { value: false })
        if (outcome === 'expired') Object.defineProperty(f.view, 'expiresAt', { value: 0 })
        if (outcome === 'cleanup-failed') {
          const rejected = Promise.reject(cleanup)
          void rejected.catch(() => undefined)
          Object.defineProperty(f.view, 'closed', { value: rejected })
        }
      }
    }
    const running = runSnapshotSyncSession(f.input, options)
    if (outcome === 'expired') await expect(running).rejects.toBeInstanceOf(SnapshotResourceLimitError)
    else if (outcome === 'cleanup-failed') await expect(running).rejects.toBe(cleanup)
    else await expect(running).rejects.toThrow('source closed')
    expect(f.apply).not.toHaveBeenCalled()
  }
)

test('an already completed destination session does not read or prepare another page', async () => {
  const f = session()
  f.checkpoint.tableIndex = 12
  f.checkpoint.done = true
  const result = await runSnapshotSyncSession(f.input, {})
  expect(result).toMatchObject({ status: 'completed', pages: 0, snapshotCheckpoint: { done: true } })
  expect(f.view.readPage).not.toHaveBeenCalled()
  expect(f.destination.prepare).not.toHaveBeenCalled()
})

test.each([
  ['version', 2],
  ['sessionId', 'changed'],
  ['identityKey', 'another-profile'],
  ['sourceStorageIdentityKey', 'another-source'],
  ['destinationStorageIdentityKey', 'another-destination'],
  ['snapshotId', 'another-view'],
  ['sequence', 11],
  ['tableIndex', 11],
  ['done', false],
  ['cursor', { version: 1, snapshotId: 'b'.repeat(64), table: 'provenTxReqs', after: [7] }]
])('a mismatched acknowledged %s rejects before counting or reading another page', async (field, value) => {
  const f = session()
  const commit = await f.apply()
  f.apply.mockClear()
  f.apply.mockResolvedValue({ ...commit, checkpoint: { ...commit.checkpoint, [field as string]: value } })
  const states: string[] = []
  await expect(
    runSnapshotSyncSession(f.input, { onProgress: progress => states.push(progress.state) })
  ).rejects.toThrow('acknowledgement does not match')
  expect(f.apply).toHaveBeenCalledTimes(1)
  expect(f.view.readPage).toHaveBeenCalledTimes(1)
  expect(states).not.toContain('committed')
  expect(states).not.toContain('completed')
})

test('progress timings separate read, preparation, queue and commit costs', async () => {
  const f = session()
  let now = 1000
  const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
  const budget = jest.spyOn(SyncPageBudget.prototype, 'committed')
  const progress: SyncSessionProgress[] = []
  ;(f.view.readPage as jest.Mock).mockImplementation(async () => {
    now += 11
    return { rows: [], payloadBytes: 0, done: true }
  })
  ;(f.destination.prepare as jest.Mock).mockImplementation(async () => {
    now += 13
    return f.apply
  })
  const apply = f.apply.getMockImplementation()!
  f.apply.mockImplementation(async () => {
    now += 19
    return await apply()
  })
  let commits = 0
  f.commit.mockImplementation(async work => {
    if (++commits === 2) now += 17
    return await work()
  })
  try {
    await runSnapshotSyncSession(f.input, { onProgress: event => progress.push(event) })
    expect(progress.find(event => event.state === 'preparing')).toMatchObject({ readMs: 11 })
    expect(progress.find(event => event.state === 'committing')).toMatchObject({ readMs: 11, prepareMs: 13 })
    expect(progress.find(event => event.state === 'committed')).toMatchObject({
      readMs: 11,
      prepareMs: 13,
      queueMs: 17,
      commitMs: 19
    })
    expect(budget).toHaveBeenCalledWith(expect.any(Object), 43, 24, 0)
  } finally {
    budget.mockRestore()
    clock.mockRestore()
  }
})

test('actual returned payload charges bound the next request while every page commits in order', async () => {
  const f = session()
  const requested: Array<{ maxRows: number; maxBytes: number }> = []
  let remaining = 40
  let position = 7
  let durable = { ...f.checkpoint }
  ;(f.view.readPage as jest.Mock).mockImplementation(async (_table, _cursor, limits) => {
    requested.push({ ...limits })
    const count = Math.min(remaining, limits.maxRows, Math.floor(limits.maxBytes / 512))
    remaining -= count
    position += count
    return {
      rows: Array.from({ length: count }, () => ({})),
      payloadBytes: count * 512,
      done: remaining === 0,
      cursor: remaining === 0 ? undefined : { ...f.checkpoint.cursor, after: [position] }
    }
  })
  ;(f.destination.prepare as jest.Mock).mockImplementation(async (checkpoint, page) => {
    const expected = { ...checkpoint }
    return async () => {
      expect(durable.sequence).toBe(expected.sequence)
      durable = {
        ...expected,
        sequence: expected.sequence + 1,
        tableIndex: expected.tableIndex + Number(page.done),
        cursor: page.cursor,
        done: page.done
      }
      return { checkpoint: durable, inserts: page.rows.length, updates: 0 }
    }
  })
  const result = await runSnapshotSyncSession(f.input, { maxItems: 1000, maxRoughSize: 8192 })
  expect(result).toMatchObject({ status: 'completed', pages: 3, inserts: 40, updates: 0 })
  expect(requested[0]).toEqual({ maxRows: 64, maxBytes: 8192 })
  expect(requested.slice(1)).toEqual([
    { maxRows: 16, maxBytes: 8192 },
    { maxRows: 16, maxBytes: 8192 }
  ])
  expect(durable).toMatchObject({ sequence: 14, tableIndex: 12, done: true, cursor: undefined })
  expect(f.commit).toHaveBeenCalledTimes(4)
})

test.each([1, 10000000])('the exact byte ceiling %s remains accepted', async maxRoughSize => {
  const f = session()
  expect(await runSnapshotSyncSession(f.input, { maxItems: 1, maxRoughSize })).toMatchObject({
    status: 'completed',
    pages: 1
  })
  expect(f.view.readPage).toHaveBeenCalledWith('provenTxReqs', f.checkpoint.cursor, {
    maxRows: 1,
    maxBytes: maxRoughSize
  })
})

test('identifies the current snapshot table before reading its first page', async () => {
  const f = session()
  const apply = jest.spyOn(SyncPageBudget.prototype, 'apply')
  const beginTable = jest.spyOn(SyncPageBudget.prototype, 'beginTable')
  try {
    await runSnapshotSyncSession(f.input, { maxItems: 17, maxRoughSize: 8192 })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(beginTable).toHaveBeenCalledTimes(1)
    expect(beginTable).toHaveBeenCalledWith('provenTxReqs')
    expect(beginTable.mock.invocationCallOrder[0]).toBeLessThan(apply.mock.invocationCallOrder[0])
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ maxItems: 17, maxRoughSize: 8192 }))
    expect(f.view.readPage).toHaveBeenCalledWith('provenTxReqs', f.checkpoint.cursor, { maxRows: 17, maxBytes: 8192 })
  } finally {
    apply.mockRestore()
    beginTable.mockRestore()
  }
})
