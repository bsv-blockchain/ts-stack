import {
  addSnapshotProfileIndexes,
  removeSnapshotProfileIndexes,
  snapshotProfileTables
} from '../schema/snapshotProfileIndexMigration'
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
import { addSnapshotRelationIndexes } from '../schema/snapshotRelationIndexMigration'
import {
  expectRelationMembership,
  minimalRelationDatabase,
  relationFixtures
} from '../../../test/utils/snapshotRelationFixtures'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated relation writes preserve OR ownership through parent moves, rekeys, tombstones, rollback and restart', async () => {
  const k = await minimalRelationDatabase()
  try {
    await addSnapshotRelationIndexes(k)
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            pair: fc.integer({ min: 0, max: 1 }),
            left: fc.integer({ min: 1, max: 5 }),
            right: fc.integer({ min: 1, max: 5 }),
            owner: fc.integer({ min: 1, max: 3 }),
            kind: fc.constantFrom(
              'left',
              'right',
              'map',
              'tombstone',
              'delete-map',
              'delete-left',
              'delete-right',
              'left-key',
              'right-key',
              'map-key',
              'rollback',
              'repeat'
            )
          }),
          { minLength: 1, maxLength: 25 }
        ),
        async schedule => {
          await runInSeries(relationFixtures, async p => {
            await k(p.table).delete()
            await k(p.left).delete()
            await k(p.right).delete()
          })
          await runInSeries(schedule, async op => {
            const p = relationFixtures[op.pair]
            if (op.kind === 'left')
              await k(p.left)
                .insert({ [p.leftKey]: op.left, userId: op.owner })
                .onConflict(p.leftKey)
                .merge()
            else if (op.kind === 'right')
              await k(p.right)
                .insert({ [p.rightKey]: op.right, userId: op.owner })
                .onConflict(p.rightKey)
                .merge()
            else if (op.kind === 'map')
              await k(p.table)
                .insert({ [p.leftKey]: op.left, [p.rightKey]: op.right, isDeleted: false })
                .onConflict([p.leftKey, p.rightKey])
                .ignore()
            else if (op.kind === 'tombstone')
              await k(p.table)
                .where({ [p.leftKey]: op.left, [p.rightKey]: op.right })
                .update({ isDeleted: true })
            else if (op.kind === 'delete-map')
              await k(p.table)
                .where({ [p.leftKey]: op.left, [p.rightKey]: op.right })
                .delete()
            else if (op.kind === 'delete-left') await k(p.left).where(p.leftKey, op.left).delete()
            else if (op.kind === 'delete-right') await k(p.right).where(p.rightKey, op.right).delete()
            else if (op.kind === 'left-key' || op.kind === 'right-key' || op.kind === 'map-key') {
              try {
                if (op.kind === 'left-key')
                  await k(p.left)
                    .where(p.leftKey, op.left)
                    .update({ [p.leftKey]: (op.left % 5) + 1 })
                else if (op.kind === 'right-key')
                  await k(p.right)
                    .where(p.rightKey, op.right)
                    .update({ [p.rightKey]: (op.right % 5) + 1 })
                else
                  await k(p.table)
                    .where({ [p.leftKey]: op.left, [p.rightKey]: op.right })
                    .update({ [p.leftKey]: (op.left % 5) + 1, [p.rightKey]: (op.right % 5) + 1 })
              } catch (error) {
                if ((error as { code?: string }).code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') throw error
              }
            } else if (op.kind === 'repeat') await addSnapshotRelationIndexes(k)
            else {
              const failure = new Error('synthetic relation rollback')
              await expect(
                k.transaction(async trx => {
                  await trx(p.left)
                    .insert({ [p.leftKey]: op.left, userId: op.owner })
                    .onConflict(p.leftKey)
                    .merge()
                  throw failure
                })
              ).rejects.toBe(failure)
            }
            await expectRelationMembership(k)
          })
        }
      )
    )
  } finally {
    await k.destroy()
  }
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

test('generated source writes, profile moves, rollback and restart preserve exact auxiliary membership', async () => {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await runInSeries(snapshotProfileTables, async ({ table, key }) => {
      await k.schema.createTable(table, columns => {
        columns.integer(key).primary()
        columns.integer('userId').notNullable()
        columns.text('value')
      })
    })
    await addSnapshotProfileIndexes(k)
    const verify = async (): Promise<void> => {
      const expected: Array<{ snapshotTableId: number; snapshotUserId: number; snapshotRowId: number }> = []
      await runInSeries(snapshotProfileTables.entries(), async ([snapshotTableId, { table, key }]) => {
        const rows: Array<Record<string, number>> = await k(table).select(key, 'userId')
        expected.push(...rows.map(row => ({ snapshotTableId, snapshotUserId: row.userId, snapshotRowId: row[key] })))
      })
      expected.sort(
        (a, b) =>
          a.snapshotTableId - b.snapshotTableId ||
          a.snapshotUserId - b.snapshotUserId ||
          a.snapshotRowId - b.snapshotRowId
      )
      expect(await k('snapshot_profile_keys').orderBy(['snapshotTableId', 'snapshotUserId', 'snapshotRowId'])).toEqual(
        expected
      )
    }
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            tableId: fc.integer({ min: 0, max: 7 }),
            rowId: fc.integer({ min: 1, max: 20 }),
            owner: fc.integer({ min: 1, max: 4 }),
            kind: fc.constantFrom('insert-or-update', 'delete', 'rollback', 'rebuild', 'repeat'),
            value: fc.string({ maxLength: 12 })
          }),
          { minLength: 1, maxLength: 12 }
        ),
        async schedule => {
          await runInSeries(snapshotProfileTables, async ({ table }) => {
            await k(table).delete()
          })
          await verify()
          await runInSeries(schedule, async operation => {
            const { table, key } = snapshotProfileTables[operation.tableId]
            const row = { [key]: operation.rowId, userId: operation.owner, value: operation.value }
            if (operation.kind === 'insert-or-update') await k(table).insert(row).onConflict(key).merge()
            else if (operation.kind === 'delete') await k(table).where(key, operation.rowId).delete()
            else if (operation.kind === 'rollback') {
              const rollback = new Error('synthetic rollback')
              await expect(
                k.transaction(async trx => {
                  await trx(table).insert(row).onConflict(key).merge()
                  throw rollback
                })
              ).rejects.toBe(rollback)
            } else if (operation.kind === 'rebuild') {
              await removeSnapshotProfileIndexes(k)
              await addSnapshotProfileIndexes(k)
            } else await addSnapshotProfileIndexes(k)
            await verify()
          })
        }
      )
    )
  } finally {
    await k.destroy()
  }
})
