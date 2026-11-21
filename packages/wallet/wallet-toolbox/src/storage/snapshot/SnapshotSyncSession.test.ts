import { SnapshotWorkingAllocationLimitError } from './SnapshotWorkingAllocationLimitError'
import { runSnapshotSyncSession } from './runSnapshotSyncSession'
import type {
  WalletReadSnapshot,
  WalletSnapshotCursor,
  WalletSnapshotTable,
  WalletSnapshotPageLimits,
  WalletSnapshotFieldMetadataPage
} from './WalletReadSnapshot'
import type { SnapshotSyncCheckpoint, SnapshotSyncCommit, SnapshotSyncStorage, SnapshotSyncTable } from './SnapshotSync'
import type { SyncSessionOptions, SyncSessionProgress } from '../sync/syncSession'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'
import { SyncPageBudget } from '../sync/SyncPageBudget'
import { StorageAccessQueue } from '../sync/StorageAccessQueue'

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

function fieldSession() {
  const f = session(),
    reader = {
      readMetadataPage: jest.fn(
        async (
          _table?: WalletSnapshotTable,
          _cursor?: WalletSnapshotCursor,
          _limits?: WalletSnapshotPageLimits
        ): Promise<WalletSnapshotFieldMetadataPage<SnapshotSyncTable>> => ({ rows: [], payloadBytes: 0, done: true })
      ),
      readFieldExtent: jest.fn(async () => new Uint8Array([7]))
    },
    close = jest.fn(async (): Promise<void> => {}),
    prepareFields = jest.fn(
      async (
        _checkpoint?: SnapshotSyncCheckpoint,
        _page?: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>,
        _view?: WalletReadSnapshot,
        _signal?: AbortSignal
      ) => ({ apply: f.apply, close })
    )
  Reflect.set(f.view, 'fieldReader', reader)
  Reflect.set(f.destination, 'prepareFields', prepareFields)
  return { ...f, reader, close, prepareFields }
}

test('queued snapshot cancellation drains the prepared fields before unrelated ownership is released', async () => {
  const f = fieldSession(),
    queue = new StorageAccessQueue(),
    controller = new AbortController()
  let releaseOwner: (() => void) | undefined
  const pending = runSnapshotSyncSession(
    {
      ...f.input,
      commit: async <T>(operation: () => Promise<T>) => {
        const release = await queue.acquire('exclusive', 'background', controller.signal)
        try {
          return await operation()
        } finally {
          release()
        }
      }
    },
    {
      signal: controller.signal,
      onProgress: state => {
        if (state.state !== 'committing') return
        // acquire grants synchronously; its promise continuation captures release.
        void queue.acquire('exclusive').then(release => {
          releaseOwner = release
          controller.abort()
        })
      }
    }
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Queued snapshot cancellation waited for unrelated ownership')), 3000)
      })
    ])
    expect(result).toMatchObject({ status: 'cancelled', pages: 0 })
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(releaseOwner).toBeDefined()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    releaseOwner?.()
    await pending
  }
})

test('paired field negotiation prepares outside write admission and drains only after the writer returns', async () => {
  const f = fieldSession(),
    order: string[] = []
  let writing = false
  f.commit.mockImplementation(async work => {
    writing = true
    try {
      return await work()
    } finally {
      writing = false
      order.push('writer-drained')
    }
  })
  f.prepareFields.mockImplementation(async () => {
    expect(writing).toBe(false)
    order.push('prepare')
    expect(await f.reader.readFieldExtent()).toEqual(new Uint8Array([7]))
    return { apply: f.apply, close: f.close }
  })
  f.close.mockImplementation(async () => {
    expect(writing).toBe(false)
    order.push('close')
  })
  const result = await runSnapshotSyncSession(f.input, { maxItems: 1, maxRoughSize: 8192 })
  expect(result.pages).toBe(1)
  expect(f.apply).toHaveBeenCalledTimes(1)
  expect(f.prepareFields).toHaveBeenCalledWith(
    f.checkpoint,
    { rows: [], payloadBytes: 0, done: true },
    f.view,
    undefined
  )
  expect(f.reader.readMetadataPage).toHaveBeenCalledWith('provenTxReqs', f.checkpoint.cursor, {
    maxRows: 1,
    maxBytes: 8192
  })
  expect(f.view.readPage).not.toHaveBeenCalled()
  expect(f.destination.prepare).not.toHaveBeenCalled()
  expect(order).toEqual(['writer-drained', 'prepare', 'writer-drained', 'close'])
})

test.each(['source', 'destination'])('unpaired %s field support preserves the full-row path', async missing => {
  const f = fieldSession()
  Reflect.deleteProperty(
    missing === 'source' ? f.view : f.destination,
    missing === 'source' ? 'fieldReader' : 'prepareFields'
  )
  await runSnapshotSyncSession(f.input, {})
  expect(f.view.readPage).toHaveBeenCalledTimes(1)
  expect(f.destination.prepare).toHaveBeenCalledTimes(1)
  expect(f.reader.readMetadataPage).not.toHaveBeenCalled()
  expect(f.prepareFields).not.toHaveBeenCalled()
})

test('fresh field refusal preserves the legacy row path without copying field metadata', async () => {
  const f = fieldSession(),
    probe = jest.fn(async () => false)
  Reflect.set(f.destination, 'supportsFieldDestination', probe)
  await runSnapshotSyncSession(f.input, {})
  expect(probe).toHaveBeenCalledTimes(1)
  expect(f.view.readPage).toHaveBeenCalledTimes(1)
  expect(f.destination.prepare).toHaveBeenCalledTimes(1)
  expect(f.reader.readMetadataPage).not.toHaveBeenCalled()
  expect(f.prepareFields).not.toHaveBeenCalled()
})

test('partial or changed field installation cannot silently select legacy fallback', async () => {
  const f = fieldSession(),
    failure = new Error('Original native schema differs')
  Reflect.set(f.destination, 'supportsFieldDestination', async () => {
    throw failure
  })
  await expect(runSnapshotSyncSession(f.input, {})).rejects.toBe(failure)
  expect(f.view.readPage).not.toHaveBeenCalled()
  expect(f.destination.prepare).not.toHaveBeenCalled()
  expect(f.reader.readMetadataPage).not.toHaveBeenCalled()
  expect(f.prepareFields).not.toHaveBeenCalled()
})

test.each([32, 128])(
  'row admission intersects the remote ceiling %s with adaptive and original caller limits',
  async maxRows => {
    const bounded = session()
    Reflect.set(bounded.destination, 'pageLimits', Object.freeze({ maxRows, maxBytes: 262144 }))
    await runSnapshotSyncSession(bounded.input, { maxItems: 1000, maxRoughSize: 10000000 })
    expect(bounded.view.readPage).toHaveBeenCalledWith('provenTxReqs', bounded.checkpoint.cursor, {
      // The first table page starts at 64; a lower negotiated limit still binds.
      maxRows: Math.min(maxRows, 64),
      maxBytes: 262144
    })
    const smaller = session()
    Reflect.set(smaller.destination, 'pageLimits', Object.freeze({ maxRows, maxBytes: 262144 }))
    await runSnapshotSyncSession(smaller.input, { maxItems: 2, maxRoughSize: 4096 })
    expect(smaller.view.readPage).toHaveBeenCalledWith('provenTxReqs', smaller.checkpoint.cursor, {
      maxRows: 2,
      maxBytes: 4096
    })
  }
)

test.each([
  { maxRows: 0, maxBytes: 4096 },
  { maxRows: 1.5, maxBytes: 4096 },
  { maxRows: 128, maxBytes: NaN },
  { maxRows: 1001, maxBytes: 4096 }
])('invalid row admission refuses before source read: %j', async limits => {
  const f = session()
  Reflect.set(f.destination, 'pageLimits', limits)
  await expect(runSnapshotSyncSession(f.input, {})).rejects.toThrow('row limits')
  expect(f.view.readPage).not.toHaveBeenCalled()
  expect(f.destination.prepare).not.toHaveBeenCalled()
  expect(f.apply).not.toHaveBeenCalled()
})

test('field admission intersects destination ceilings with the original caller limits', async () => {
  const bounded = fieldSession()
  Reflect.set(bounded.destination, 'fieldPageLimits', Object.freeze({ maxRows: 8, maxBytes: 262144 }))
  await runSnapshotSyncSession(bounded.input, { maxItems: 1000, maxRoughSize: 10000000 })
  expect(bounded.reader.readMetadataPage).toHaveBeenCalledWith('provenTxReqs', bounded.checkpoint.cursor, {
    maxRows: 8,
    maxBytes: 262144
  })
  const smaller = fieldSession()
  Reflect.set(smaller.destination, 'fieldPageLimits', Object.freeze({ maxRows: 8, maxBytes: 262144 }))
  await runSnapshotSyncSession(smaller.input, { maxItems: 2, maxRoughSize: 4096 })
  expect(smaller.reader.readMetadataPage).toHaveBeenCalledWith('provenTxReqs', smaller.checkpoint.cursor, {
    maxRows: 2,
    maxBytes: 4096
  })
})

test.each([
  { maxRows: 0, maxBytes: 4096 },
  { maxRows: 1.5, maxBytes: 4096 },
  { maxRows: 8, maxBytes: NaN }
])('invalid field admission refuses before source read: %j', async limits => {
  const f = fieldSession()
  Reflect.set(f.destination, 'fieldPageLimits', limits)
  await expect(runSnapshotSyncSession(f.input, {})).rejects.toThrow('field limits')
  expect(f.reader.readMetadataPage).not.toHaveBeenCalled()
  expect(f.prepareFields).not.toHaveBeenCalled()
  expect(f.apply).not.toHaveBeenCalled()
})

test('field preparation failure propagates without replaying a full row', async () => {
  const f = fieldSession(),
    failure = new Error('Original source field differs')
  f.prepareFields.mockRejectedValueOnce(failure)
  await expect(runSnapshotSyncSession(f.input, {})).rejects.toBe(failure)
  expect(f.view.readPage).not.toHaveBeenCalled()
  expect(f.destination.prepare).not.toHaveBeenCalled()
  expect(f.apply).not.toHaveBeenCalled()
})

test('cancellation after field preparation drains once before yielding its durable state', async () => {
  const f = fieldSession(),
    controller = new AbortController()
  f.prepareFields.mockImplementationOnce(async () => {
    controller.abort()
    return { apply: f.apply, close: f.close }
  })
  const result = await runSnapshotSyncSession(f.input, { signal: controller.signal })
  expect(result.status).toBe('cancelled')
  expect(result.pages).toBe(0)
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.apply).not.toHaveBeenCalled()
})

test('a closed source drains field preparation before waiting for original source cleanup', async () => {
  const f = fieldSession()
  let released!: () => void
  Reflect.set(
    f.view,
    'closed',
    new Promise<void>(resolve => {
      released = resolve
    })
  )
  f.close.mockImplementation(async () => {
    released()
  })
  await expect(
    runSnapshotSyncSession(f.input, {
      onProgress: progress => {
        if (progress.state === 'committing') Reflect.set(f.view, 'isOpen', false)
      }
    })
  ).rejects.toThrow('closed before destination commit')
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.apply).not.toHaveBeenCalled()
})

test('field commit and drainage failures both remain attached', async () => {
  const f = fieldSession(),
    failure = new Error('Original destination changed'),
    cleanup = new Error('Original drainage failed')
  f.apply.mockRejectedValueOnce(failure)
  f.close.mockRejectedValueOnce(cleanup)
  let received: unknown
  try {
    await runSnapshotSyncSession(f.input, {})
  } catch (cause) {
    received = cause
  }
  expect(received).toBeInstanceOf(AggregateError)
  expect((received as AggregateError).errors).toEqual([failure, cleanup])
  expect(f.close).toHaveBeenCalledTimes(1)
})

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
  const budget = jest.spyOn(SyncPageBudget.prototype, 'committedSnapshot')
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
    expect(budget).toHaveBeenCalledWith('provenTxReqs', 0, 43, 24, 0)
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

test('adaptive field paging observes actual verification/replay bytes and reports them separately from metadata charge', async () => {
  const f = fieldSession(),
    progress: SyncSessionProgress[] = [],
    committed = jest.spyOn(SyncPageBudget.prototype, 'committedSnapshot')
  let bytes = 200
  Object.defineProperty(f.reader, 'extentBytesRead', { get: () => bytes })
  f.prepareFields.mockImplementationOnce(async () => {
    bytes += 140000
    return { apply: f.apply, close: f.close }
  })
  try {
    await runSnapshotSyncSession(f.input, {
      onProgress: value => {
        progress.push(value)
      }
    })
    expect(committed).toHaveBeenCalledWith('provenTxReqs', 0, expect.any(Number), expect.any(Number), 140000)
    expect(progress.find(value => value.state === 'committed')?.fieldBytesRead).toBe(140000)
    expect(f.close).toHaveBeenCalledTimes(1)
  } finally {
    committed.mockRestore()
  }
})

test('field read telemetry refusal drains the real preparation before any writer is admitted', async () => {
  const f = fieldSession()
  let bytes = 100
  Object.defineProperty(f.reader, 'extentBytesRead', { get: () => bytes })
  f.prepareFields.mockImplementationOnce(async () => {
    bytes = 99
    return { apply: f.apply, close: f.close }
  })
  await expect(runSnapshotSyncSession(f.input, {})).rejects.toThrow('telemetry changed')
  expect(f.close).toHaveBeenCalledTimes(1)
  expect(f.apply).not.toHaveBeenCalled()
})

test('a drained working reservation refusal rereads a smaller prefix at the same source cursor before committing', async () => {
  const f = fieldSession(),
    cursors: unknown[] = [],
    limits: number[] = []
  f.reader.readMetadataPage.mockImplementation(async (_table, cursor, selected) => {
    cursors.push(cursor)
    limits.push(selected!.maxRows!)
    return {
      rows: Array.from({ length: selected!.maxRows! }, (_, index) => ({
        fields: { provenTxReqId: 8 + index },
        extents: {},
        cursor: {
          version: 1 as const,
          snapshotId: f.checkpoint.snapshotId,
          table: 'provenTxReqs' as const,
          after: [8 + index]
        }
      })),
      payloadBytes: 4096,
      done: true
    }
  })
  f.prepareFields.mockRejectedValueOnce(new SnapshotWorkingAllocationLimitError('Original combined allocation'))
  f.apply.mockResolvedValueOnce({
    checkpoint: { ...f.checkpoint, sequence: 12, tableIndex: 12, cursor: undefined, done: true },
    inserts: 1,
    updates: 0
  })
  await runSnapshotSyncSession(f.input, { maxItems: 4 })
  expect(limits).toEqual([4, 2])
  expect(cursors).toEqual([f.checkpoint.cursor, f.checkpoint.cursor])
  expect(f.prepareFields.mock.calls.every(call => call[0] === f.checkpoint && call[2] === f.view)).toBe(true)
  expect(f.apply).toHaveBeenCalledTimes(1)
  expect(f.close).toHaveBeenCalledTimes(1)
})

test('storage quota refusal never retries an accepted source as a smaller or serialized copy', async () => {
  const f = fieldSession(),
    failure = new SnapshotResourceLimitError('Original storage quota')
  f.prepareFields.mockRejectedValueOnce(failure)
  await expect(runSnapshotSyncSession(f.input, { maxItems: 4 })).rejects.toBe(failure)
  expect(f.reader.readMetadataPage).toHaveBeenCalledTimes(1)
  expect(f.view.readPage).not.toHaveBeenCalled()
  expect(f.apply).not.toHaveBeenCalled()
})
