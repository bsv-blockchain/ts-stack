import {
  Brc38CleanupScope,
  Brc38StagingCleanupError,
  closeBrc38UnpooledConnection,
  drainBrc38FailedConnections
} from './Brc38StagingCleanupError'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function latch() {
  let release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  return { pending, release }
}

test('initial teardown callers share the actual pending drain and the same rejection without retrying it', async () => {
  const gate = latch(),
    cause = new Error('initial physical teardown failed'),
    cleanup = jest.fn(async () => {
      await gate.pending
      throw cause
    }),
    scope = new Brc38CleanupScope(cleanup),
    first = scope.close(),
    second = scope.close()
  expect(second).toBe(first)
  const observed = Promise.allSettled([first, second])
  gate.release()
  expect(await observed).toEqual([
    { status: 'rejected', reason: cause },
    { status: 'rejected', reason: cause }
  ])
  await expect(scope.close()).rejects.toBe(cause)
  expect(cleanup).toHaveBeenCalledTimes(1)
})

test('cleanup revokes actor admission synchronously before awaiting its physical drain', async () => {
  const gate = latch()
  let live = true
  const scope = new Brc38CleanupScope(async () => {
    live = false
    await gate.pending
  })
  const closing = scope.close()
  try {
    expect(live).toBe(false)
    expect(scope.close()).toBe(closing)
  } finally {
    gate.release()
    await closing
  }
})

test('physical retry preserves original non-Error causes and completes only after owned teardown settles', async () => {
  const original = { operation: 'synthetic import failure' },
    teardown = new Error('synthetic close refusal'),
    gate = latch()
  let held = true
  const close = jest.fn(async () => {
      await gate.pending
      held = false
    }),
    failure = new Brc38StagingCleanupError([original, teardown], 'Private import cleanup pending', close)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([original, teardown])
  const pending = failure.retryCleanup()
  expect(held).toBe(true)
  gate.release()
  await pending
  expect(held).toBe(false)
  await failure.retryCleanup()
  expect(close).toHaveBeenCalledTimes(1)
  expect(failure.errors[0]).toBe(original)
  expect(failure.errors[1]).toBe(teardown)
})

test('concurrent retry cannot start a second native teardown and does not complete the first owner', async () => {
  const gate = latch(),
    close = jest.fn(async () => await gate.pending),
    failure = new Brc38StagingCleanupError([], 'Physical cleanup pending', close),
    pending = failure.retryCleanup()
  try {
    await expect(failure.retryCleanup()).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    gate.release()
    await pending
  }
  await failure.retryCleanup()
  expect(close).toHaveBeenCalledTimes(1)
})

test('a rejected native teardown remains retryable and its rejection identity is preserved', async () => {
  const original = new Error('synthetic operation failure'),
    next = { close: 'synthetic retry refusal' },
    close = jest.fn<Promise<void>, []>().mockRejectedValueOnce(next).mockResolvedValue(undefined),
    failure = new Brc38StagingCleanupError([original], 'Physical cleanup pending', close)
  await expect(failure.retryCleanup()).rejects.toBe(next)
  await failure.retryCleanup()
  await failure.retryCleanup()
  expect(close).toHaveBeenCalledTimes(2)
  expect(failure.errors).toEqual([original])
})

test.each(['admission', 'inventory', 'stage'] as const)(
  'failed actual %s setup closes its raw SQLite connection before pool ownership',
  async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'brc38-unpooled-setup-')),
      cause = new Error('Actual SQLite setup failed before pool ownership'),
      original = Database.prototype.exec
    const observed: { raw?: Database.Database } = {}
    let closeOwner: (() => Promise<void>) | undefined
    const fault = jest.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
      if (this.name.startsWith(directory + '/') && sql.includes('PRAGMA')) {
        observed.raw = this
        throw cause
      }
      return original.call(this, sql)
    })
    try {
      let failure: unknown
      try {
        if (kind === 'admission') {
          const { Brc38StagingAdmissionNode } = await import('./Brc38StagingAdmissionNode'),
            root = await Brc38StagingAdmissionNode.create(directory, {
              maximumImports: 3,
              maximumPhysicalBytes: 15728640,
              maximumLogicalBytes: 3145728
            })
          closeOwner = async () => await root.close()
        } else if (kind === 'inventory') {
          const { Brc38ProfileInventoryNode } = await import('./Brc38ProfileInventoryNode'),
            root = await Brc38ProfileInventoryNode.create(directory, {
              maximumProfiles: 1,
              maximumPhysicalBytes: 11534336
            })
          closeOwner = async () => await root.close()
        } else {
          const { KnexBrc38StagingStore } = await import('./KnexBrc38StagingStore'),
            { resumeLimits } = await import('./Brc38ResumeFixture'),
            stage = await KnexBrc38StagingStore.create(directory, resumeLimits())
          closeOwner = async () => await stage.close()
        }
      } catch (error_) {
        failure = error_
      }
      expect(failure).toBe(cause)
      expect(observed.raw).toBeDefined()
      expect(observed.raw?.open).toBe(false)
    } finally {
      fault.mockRestore()
      if (observed.raw?.open === true) observed.raw.close()
      await closeOwner?.()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('non-Error setup causes retain the original fallback and close an actual raw SQLite handle', () => {
  const raw = new Database(':memory:')
  try {
    const failure = closeBrc38UnpooledConnection(raw, 'non-Error setup failure', 'Original setup fallback')
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe('Original setup fallback')
    expect(raw.open).toBe(false)
  } finally {
    if (raw.open) raw.close()
  }
})

test('raw and pool teardown both run after setup failure and retain both actual connections for retry', async () => {
  const raw = new Database(':memory:'),
    pool = new Database(':memory:'),
    setupCause = new Error('Actual raw setup refused'),
    rawCause = new Error('Actual raw close refused'),
    poolCause = new Error('Actual pool close refused'),
    closeRaw = jest.spyOn(raw, 'close').mockImplementation(() => {
      throw rawCause
    }),
    closePool = jest.spyOn(pool, 'close').mockImplementation(() => {
      throw poolCause
    })
  try {
    const setup = closeBrc38UnpooledConnection(raw, setupCause, 'Unused fallback')
    expect(setup).toBeInstanceOf(Brc38StagingCleanupError)
    let failure: unknown
    try {
      await drainBrc38FailedConnections(
        setup,
        async () => {
          pool.close()
        },
        'Concrete SQLite cleanup remains'
      )
    } catch (error_) {
      failure = error_
    }
    expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
    const retained = failure as Brc38StagingCleanupError
    expect(retained.message).toBe('Concrete SQLite cleanup remains')
    expect(retained.errors[0]).toBe(setup)
    expect((setup as Brc38StagingCleanupError).errors).toEqual([setupCause, rawCause])
    expect((retained.errors[1] as AggregateError).errors).toEqual([poolCause, rawCause])
    expect(closeRaw).toHaveBeenCalledTimes(2)
    expect(closePool).toHaveBeenCalledTimes(1)
    expect(raw.open).toBe(true)
    expect(pool.open).toBe(true)
    closeRaw.mockRestore()
    closePool.mockRestore()
    await retained.retryCleanup()
    await retained.retryCleanup()
    expect(raw.open).toBe(false)
    expect(pool.open).toBe(false)
  } finally {
    closeRaw.mockRestore()
    closePool.mockRestore()
    if (raw.open) raw.close()
    if (pool.open) pool.close()
  }
})
