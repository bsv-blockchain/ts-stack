import { knex } from 'knex'
import { withSnapshotJournalConnections, SnapshotJournalConnectionCleanupError } from './SnapshotJournalConnections'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function pool() {
  return knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
}
async function fixture() {
  const writer = pool(),
    reader = pool()
  return {
    writer,
    reader,
    close: async () => {
      await writer.destroy()
      await reader.destroy()
    }
  }
}

test('both single-slot pools are reserved before work; release permits later independent work', async () => {
  const f = await fixture()
  try {
    const started = deferred<void>(),
      finish = deferred<void>()
    const operation = withSnapshotJournalConnections(
      f.writer,
      f.reader,
      () => undefined,
      async (a, b) => {
        expect(a).not.toBe(b)
        expect(f.writer.client.pool.numUsed()).toBe(1)
        expect(f.reader.client.pool.numUsed()).toBe(1)
        await f.writer.raw('CREATE TABLE x (id INTEGER)').connection(a)
        await f.reader.raw('CREATE TABLE y (id INTEGER)').connection(b)
        started.resolve()
        await finish.promise
        return 7
      }
    )
    await started.promise
    expect(f.writer.client.pool.numUsed()).toBe(1)
    finish.resolve()
    expect(await operation).toBe(7)
    expect(f.writer.client.pool.numUsed()).toBe(0)
    expect(f.reader.client.pool.numUsed()).toBe(0)
    await f.writer('x').insert({ id: 1 })
    await f.reader('y').insert({ id: 2 })
  } finally {
    await f.close()
  }
})

test.each(['writer', 'reader'] as const)('an occupied %s pool cannot run the barrier callback', async held => {
  const f = await fixture()
  const hold = f[held],
    connection = await hold.client.acquireConnection()
  try {
    const other = held === 'writer' ? f.reader : f.writer
    const acquired = deferred<void>()
    const acquire = other.client.acquireConnection.bind(other.client)
    jest.spyOn(other.client, 'acquireConnection').mockImplementation(async () => {
      const value = await acquire()
      acquired.resolve()
      return value
    })
    let cancelled = false
    const action = jest.fn(async () => 7)
    const operation = withSnapshotJournalConnections(
      f.writer,
      f.reader,
      () => {
        if (cancelled) throw new Error('cancelled')
      },
      action
    )
    const rejection = expect(operation).rejects.toThrow('cancelled')
    await acquired.promise
    expect(action).not.toHaveBeenCalled()
    cancelled = true
    await hold.client.releaseConnection(connection)
    await rejection
    expect(action).not.toHaveBeenCalled()
    expect(other.client.pool.numUsed()).toBe(0)
    expect(hold.client.pool.numUsed()).toBe(0)
  } finally {
    await f.close()
  }
})

test.each(['writer', 'reader'] as const)(
  'failed %s acquisition drains a late successful peer before rejecting',
  async failed => {
    const f = await fixture()
    try {
      const late = failed === 'writer' ? f.reader : f.writer
      const allow = deferred<void>(),
        entered = deferred<void>()
      const acquire = late.client.acquireConnection.bind(late.client)
      jest.spyOn(late.client, 'acquireConnection').mockImplementation(async () => {
        entered.resolve()
        await allow.promise
        return await acquire()
      })
      jest.spyOn(f[failed].client, 'acquireConnection').mockRejectedValue(new Error('acquire failed'))
      let settled = false
      const action = jest.fn(async () => 7)
      const operation = withSnapshotJournalConnections(f.writer, f.reader, () => undefined, action)
      void operation.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      const rejection = expect(operation).rejects.toThrow('Snapshot connection acquisition failed')
      await entered.promise
      expect(settled).toBe(false)
      expect(action).not.toHaveBeenCalled()
      allow.resolve()
      await rejection
      expect(late.client.pool.numUsed()).toBe(0)
      expect(action).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  }
)

test('run failure still releases both pools and retains the original error', async () => {
  const f = await fixture()
  try {
    const error = new Error('pin failed')
    await expect(
      withSnapshotJournalConnections(
        f.writer,
        f.reader,
        () => undefined,
        async () => {
          throw error
        }
      )
    ).rejects.toBe(error)
    expect(f.writer.client.pool.numUsed()).toBe(0)
    expect(f.reader.client.pool.numUsed()).toBe(0)
  } finally {
    await f.close()
  }
})

test('cleanup failure waits for the other release and preserves both failure causes', async () => {
  const f = await fixture()
  const owned: unknown[] = []
  const releaseWriter = f.writer.client.releaseConnection.bind(f.writer.client)
  const releaseReader = f.reader.client.releaseConnection.bind(f.reader.client)
  try {
    const release = deferred<void>(),
      entered = deferred<void>()
    jest.spyOn(f.writer.client, 'releaseConnection').mockRejectedValue(new Error('writer release failed'))
    jest.spyOn(f.reader.client, 'releaseConnection').mockImplementation(async value => {
      entered.resolve()
      await release.promise
      await releaseReader(value)
    })
    let settled = false
    const operation = withSnapshotJournalConnections(
      f.writer,
      f.reader,
      () => undefined,
      async (a, b) => {
        owned.push(a, b)
        throw new Error('read failed')
      }
    )
    void operation.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    const rejection = expect(operation).rejects.toBeInstanceOf(SnapshotJournalConnectionCleanupError)
    await entered.promise
    expect(settled).toBe(false)
    release.resolve()
    await rejection
    await expect(operation).rejects.toMatchObject({
      cause: {
        errors: [
          expect.objectContaining({ message: 'read failed' }),
          expect.objectContaining({ message: 'writer release failed' })
        ]
      }
    })
    expect(f.reader.client.pool.numUsed()).toBe(0)
  } finally {
    jest.restoreAllMocks()
    if (owned.length) await releaseWriter(owned[0])
    await f.close()
  }
})

test('already cancelled calls and shared pools refuse before native acquisition', async () => {
  const f = await fixture()
  try {
    const spy = jest.spyOn(f.writer.client, 'acquireConnection')
    await expect(
      withSnapshotJournalConnections(
        f.writer,
        f.reader,
        () => {
          throw new Error('already cancelled')
        },
        async () => 1
      )
    ).rejects.toThrow('already cancelled')
    await expect(
      withSnapshotJournalConnections(
        f.writer,
        f.writer,
        () => undefined,
        async () => 1
      )
    ).rejects.toThrow('independent owned')
    expect(spy).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('caller-owned transactions cannot be borrowed as new pool reservations', async () => {
  const f = await fixture()
  try {
    await f.writer.transaction(async trx => {
      await expect(
        withSnapshotJournalConnections(
          trx,
          f.reader,
          () => undefined,
          async () => 1
        )
      ).rejects.toThrow('independent owned')
      await expect(
        withSnapshotJournalConnections(
          f.reader,
          trx,
          () => undefined,
          async () => 1
        )
      ).rejects.toThrow('independent owned')
    })
  } finally {
    await f.close()
  }
})

test('generated acquisition schedules preserve admission and release every acquired native connection', async () => {
  const fc = (await import('fast-check')).default
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        readerFirst: fc.boolean(),
        failWriter: fc.boolean(),
        failReader: fc.boolean(),
        cancelBefore: fc.boolean(),
        cancelWhileAcquiring: fc.boolean(),
        failRun: fc.boolean()
      }),
      async schedule => {
        const f = await fixture()
        const writerGate = deferred<void>(),
          readerGate = deferred<void>()
        const writerSeen = deferred<void>(),
          readerSeen = deferred<void>()
        const acquired: string[] = [],
          released: string[] = []
        let cancelled = schedule.cancelBefore
        function prepare(
          role: 'writer' | 'reader',
          gate: ReturnType<typeof deferred<void>>,
          seen: ReturnType<typeof deferred<void>>,
          fail: boolean
        ) {
          const owner = f[role],
            acquire = owner.client.acquireConnection.bind(owner.client),
            release = owner.client.releaseConnection.bind(owner.client)
          jest.spyOn(owner.client, 'acquireConnection').mockImplementation(async () => {
            await gate.promise
            if (fail) {
              seen.resolve()
              throw new Error(role + ' unavailable')
            }
            const connection = await acquire()
            acquired.push(role)
            seen.resolve()
            return connection
          })
          jest.spyOn(owner.client, 'releaseConnection').mockImplementation(async connection => {
            await release(connection)
            released.push(role)
          })
        }
        try {
          prepare('writer', writerGate, writerSeen, schedule.failWriter)
          prepare('reader', readerGate, readerSeen, schedule.failReader)
          const action = jest.fn(async () => {
            if (schedule.failRun) throw new Error('capture failed')
            return 'captured'
          })
          const operation = withSnapshotJournalConnections(
            f.writer,
            f.reader,
            () => {
              if (cancelled) throw new Error('cancelled')
            },
            action
          )
          const outcome = operation.then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error })
          )
          if (!schedule.cancelBefore) {
            const first = schedule.readerFirst ? [readerGate, readerSeen] : [writerGate, writerSeen]
            first[0].resolve()
            await first[1].promise
            expect(action).not.toHaveBeenCalled()
            cancelled = schedule.cancelWhileAcquiring
          }
          writerGate.resolve()
          readerGate.resolve()
          const result = await outcome
          const admitted =
            !schedule.cancelBefore && !schedule.cancelWhileAcquiring && !schedule.failWriter && !schedule.failReader
          expect(action).toHaveBeenCalledTimes(Number(admitted))
          expect(result.ok).toBe(admitted && !schedule.failRun)
          expect(new Set(released)).toEqual(new Set(acquired))
          expect(new Set(released).size).toBe(released.length)
          expect(f.writer.client.pool.numUsed()).toBe(0)
          expect(f.reader.client.pool.numUsed()).toBe(0)
        } finally {
          jest.restoreAllMocks()
          await f.close()
        }
      }
    ),
    {
      numRuns: 300,
      seed: 3242026,
      ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
    }
  )
})
