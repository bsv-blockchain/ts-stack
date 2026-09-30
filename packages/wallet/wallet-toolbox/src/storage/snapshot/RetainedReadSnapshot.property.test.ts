import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import type { WalletSnapshotCursor } from './WalletReadSnapshot'
import { runInSeries } from '../../utility/runInSeries'
import { retainReadSnapshot } from './RetainedReadSnapshot'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}

type Outcome = { ok: true; value: number } | { ok: false; error: unknown }
interface PendingRead {
  value: number
  release: () => void
  outcome: Promise<Outcome>
  settled: () => boolean
}

const operations = fc.array(fc.constantFrom('read', 'settle', 'close', 'cancel', 'advance'), {
  minLength: 1,
  maxLength: 40
})

afterEach(() => {
  jest.useRealTimers()
})

test('random profile rows and page budgets preserve the pinned keyset under independent writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-page-property-'))
  const open = () =>
    new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      })
    })
  const source = open()
  const writer = open()
  const identity = '02' + '11'.repeat(32)
  try {
    await source.knex.raw('PRAGMA journal_mode = WAL')
    await source.migrate('property source', 'property-storage')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser(identity)
    const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await writer.makeAvailable()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ foreign: fc.boolean(), deleted: fc.boolean(), length: fc.integer({ min: 0, max: 80 }) }), {
          maxLength: 40
        }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1100, max: 8192 }),
        async (entries, maxRows, maxBytes) => {
          await source.knex('tx_labels').del()
          const when = new Date('2026-01-01T00:00:00.000Z')
          const records = entries.map((entry, index) => ({
            txLabelId: index + 1,
            userId: entry.foreign ? other.userId : user.userId,
            label: `${index}-${'é'.repeat(entry.length)}`,
            isDeleted: entry.deleted,
            created_at: when,
            updated_at: when
          }))
          if (records.length > 0)
            await source
              .knex('tx_labels')
              .insert(records.map(row => ({ ...row, created_at: when.toISOString(), updated_at: when.toISOString() })))
          const expected = records.filter(row => row.userId === user.userId)
          const view = await source.openWalletReadSnapshot(identity)
          try {
            await writer.knex('tx_labels').where({ userId: user.userId }).update({ isDeleted: true })
            await writer.findOrInsertTxLabel(user.userId, 'post-snapshot insert')
            const actual: typeof expected = []
            let cursor: WalletSnapshotCursor | undefined
            for (let pages = 0; ; pages++) {
              expect(pages).toBeLessThanOrEqual(expected.length + 1)
              const page = await view.readPage('txLabels', cursor, { maxRows, maxBytes })
              expect(page.rows.length).toBeLessThanOrEqual(maxRows)
              expect(page.payloadBytes).toBeLessThanOrEqual(maxBytes)
              expect(await view.readPage('txLabels', cursor, { maxRows, maxBytes })).toEqual(page)
              actual.push(...page.rows)
              if (page.done) break
              expect(page.rows.length).toBeGreaterThan(0)
              cursor = page.cursor
            }
            expect(actual).toEqual(expected)
            expect(new Set(actual.map(row => row.txLabelId)).size).toBe(expected.length)
          } finally {
            await view.close()
          }
        }
      )
    )
  } finally {
    await Promise.all([source.destroy(), writer.destroy()])
    await rm(directory, { recursive: true, force: true })
  }
})

test('random schedules preserve single-read admission, late-result rejection and physical cleanup ownership', async () => {
  jest.useFakeTimers()
  await fc.assert(
    fc.asyncProperty(operations, fc.integer({ min: 1, max: 1000 }), async (steps, lifetimeMs) => {
      const controller = new AbortController()
      const cleanup = gate()
      const token = { synthetic: true }
      let physicalReads = 0
      let enteredReads = 0
      let leftCallback = false
      let released = false
      let closed = false
      let pending: PendingRead | undefined
      let expectedReads = 0
      let alive = true
      let elapsed = 0
      const lifetime = retainReadSnapshot(
        async read => {
          try {
            await read(token)
          } finally {
            leftCallback = true
            await cleanup.promise
            released = true
          }
        },
        async received => {
          expect(received).toBe(token)
        },
        { signal: controller.signal, lifetimeMs }
      )
      void lifetime.closed.catch(() => undefined)
      const view = await lifetime.opened.catch(async error => {
        cleanup.resolve()
        await lifetime.closed.catch(() => undefined)
        throw error
      })
      void view.closed.then(
        () => {
          closed = true
        },
        () => undefined
      )

      const finishRead = async (): Promise<void> => {
        if (pending === undefined) return
        const active = pending
        active.release()
        const outcome = await active.outcome
        if (alive) expect(outcome).toEqual({ ok: true, value: active.value })
        else expect(outcome).toEqual({ ok: false, error: expect.any(Error) })
        pending = undefined
        expect(physicalReads).toBe(0)
      }
      try {
        // Each generated operation awaits the previous operation's observations;
        // the database read itself remains independently held until `settle`.
        await runInSeries(steps, async step => {
          if (step === 'read') {
            if (!alive || pending !== undefined) {
              const extra = jest.fn(async () => 1)
              await expect(view.read(extra)).rejects.toBeInstanceOf(Error)
              expect(extra).not.toHaveBeenCalled()
            } else {
              const held = gate()
              const value = ++expectedReads
              let settled = false
              const outcome: Promise<Outcome> = view
                .read(async received => {
                  expect(received).toBe(token)
                  physicalReads++
                  enteredReads++
                  expect(physicalReads).toBe(1)
                  await held.promise
                  physicalReads--
                  return value
                })
                .then(
                  result => {
                    settled = true
                    return { ok: true, value: result }
                  },
                  error => {
                    settled = true
                    return { ok: false, error }
                  }
                )
              pending = { value, release: held.resolve, outcome, settled: () => settled }
            }
          } else if (step === 'settle') {
            await finishRead()
          } else if (step === 'advance') {
            elapsed += 250
            if (elapsed >= lifetimeMs) alive = false
            jest.advanceTimersByTime(250)
          } else {
            alive = false
            if (step === 'cancel') controller.abort()
            else void view.close().catch(() => undefined)
          }
          // Observe both read continuation and provider callback handoffs.
          await Promise.resolve()
          await Promise.resolve()
          expect(view.isOpen).toBe(alive)
          expect(enteredReads).toBe(expectedReads)
          expect(released).toBe(false)
          expect(closed).toBe(false)
          if (pending !== undefined) {
            expect(pending.settled()).toBe(false)
            expect(physicalReads).toBe(1)
            expect(leftCallback).toBe(false)
          }
        })
        await finishRead()
      } finally {
        const closing = view.close()
        pending?.release()
        await pending?.outcome
        cleanup.resolve()
        await closing
      }
      expect(physicalReads).toBe(0)
      expect(released).toBe(true)
      expect(closed).toBe(true)
      expect(view.isOpen).toBe(false)
      expect(jest.getTimerCount()).toBe(0)
    })
  )
})
