import fc from 'fast-check'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { snapshotSyncTables } from './SnapshotSync'
import { WalletStorageManager } from '../WalletStorageManager'
import type { WalletStorageProvider } from '../../sdk/WalletStorage.interfaces'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('random durable page schedules recover acknowledgements and restarts without profile leakage or duplicate rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-durable-property-'))
  const open = (name: string) =>
    new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, name + '.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      })
    })
  const source = open('source')
  const destination = open('destination')
  const identity = '02' + '11'.repeat(32)
  const foreignIdentity = '03' + '22'.repeat(32)
  try {
    for (const [store, name] of [
      [source, 'source'],
      [destination, 'destination']
    ] as const) {
      await store.knex.raw('PRAGMA journal_mode = WAL')
      await store.migrate(name, name)
      await store.makeAvailable()
    }
    const { user } = await source.findOrInsertUser(identity)
    const { user: foreign } = await source.findOrInsertUser(foreignIdentity)
    const { user: occupied } = await destination.findOrInsertUser(foreignIdentity)
    const { user: target } = await destination.findOrInsertUser(identity)
    await source.updateUser(user.userId, { activeStorage: 'source' })
    await destination.updateUser(target.userId, { activeStorage: 'source' })
    const writer = destination.getSnapshotSync()!
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ foreign: fc.boolean(), deleted: fc.boolean(), length: fc.integer({ min: 0, max: 80 }) }), {
          maxLength: 12
        }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 2048, max: 8192 }),
        fc.array(fc.constantFrom('commit', 'lost-ack', 'stale', 'restart', 'discard'), { maxLength: 8 }),
        async (entries, maxRows, maxBytes, steps) => {
          await destination.knex('snapshot_sync_ids').del()
          await destination.knex('snapshot_sync_sessions').del()
          await destination.knex('tx_labels').del()
          await source.knex('tx_labels').del()
          const date = new Date('2026-01-01T00:00:00.000Z')
          const records = entries.map((entry, index) => ({
            txLabelId: index + 1,
            userId: entry.foreign ? foreign.userId : user.userId,
            label: `label-${index}-${'é'.repeat(entry.length)}`,
            isDeleted: entry.deleted,
            created_at: date.toISOString(),
            updated_at: date.toISOString()
          }))
          if (records.length > 0) await source.knex('tx_labels').insert(records)
          await destination.findOrInsertTxLabel(occupied.userId, 'occupied')
          let view = (await source.getSnapshotSync()!.openSource(identity))!
          let checkpoint = await writer.begin(view, view.user.activeStorage)
          let restarted = false
          let step = 0
          const after = {
            created_at: date.toISOString(),
            updated_at: new Date(date.getTime() + 1).toISOString(),
            userId: user.userId,
            label: 'after-view',
            isDeleted: true
          }
          await source.knex('tx_labels').insert(after)
          try {
            while (!checkpoint.done) {
              expect(step).toBeLessThan(80)
              const action = steps[step++] ?? 'commit'
              const table = snapshotSyncTables[checkpoint.tableIndex]
              const page = await view.readPage(table, checkpoint.cursor, { maxRows, maxBytes })
              expect(page.rows.length).toBeLessThanOrEqual(maxRows)
              expect(page.payloadBytes).toBeLessThanOrEqual(maxBytes)
              const apply = await writer.prepare(checkpoint, page)
              if (action === 'restart' && !restarted) {
                await view.close()
                view = (await source.getSnapshotSync()!.openSource(identity))!
                checkpoint = await writer.begin(view, view.user.activeStorage)
                expect(checkpoint.sequence).toBe(0)
                await expect(apply()).rejects.toThrow('session changed')
                restarted = true
                continue
              }
              if (action === 'discard') {
                expect(await writer.checkpoint(identity, 'source')).toEqual(checkpoint)
                continue
              }
              const stale = action === 'stale' ? await writer.prepare(checkpoint, page) : undefined
              const acknowledged = await apply()
              const durable = (await writer.checkpoint(identity, 'source'))!
              expect(durable.sequence).toBe(checkpoint.sequence + 1)
              expect(durable).toEqual(acknowledged.checkpoint)
              if (stale !== undefined) await expect(stale()).rejects.toThrow('session changed')
              // A discarded acknowledgement and an observed one converge on the
              // same destination record, independent of a sender progress log.
              checkpoint = action === 'lost-ack' ? durable : acknowledged.checkpoint
            }
            const project = (row: { label: string; isDeleted: boolean }) => ({
              label: row.label,
              isDeleted: row.isDeleted
            })
            const order = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label)
            const expected = records.filter(row => row.userId === user.userId).map(project)
            if (restarted) expected.push(project(after))
            const actual = await destination.findTxLabels({ partial: { userId: target.userId } })
            expect(actual.map(project).sort(order)).toEqual(expected.sort(order))
            expect(new Set(actual.map(row => row.txLabelId)).size).toBe(expected.length)
            expect(await destination.findTxLabels({ partial: { userId: occupied.userId } })).toHaveLength(1)
            const mappings = await destination.knex('snapshot_sync_ids').where({ entity: 'txLabel' })
            expect(mappings).toHaveLength(expected.length)
            expect(
              mappings.every(row => row.userId === target.userId && row.sourceStorageIdentityKey === 'source')
            ).toBe(true)
            expect(await destination.knex('sync_states')).toHaveLength(0)
          } finally {
            await view.close()
          }
        }
      )
    )
  } finally {
    await source.destroy()
    await destination.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('primary requests retain queue order through a delayed success or failure', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('A', 'B', 'C'), { minLength: 1, maxLength: 12 }),
      fc.boolean(),
      async (requests, failFirst) => {
        const entered = deferred(),
          release = deferred(),
          failure = new Error('synthetic first primary switch failure')
        let first = true
        function provider(key: string, userId: number) {
          const settings = {
            chain: 'test',
            storageIdentityKey: key,
            storageName: key,
            dbtype: 'SQLite',
            maxOutputScriptLength: 1024
          }
          const user = { userId, identityKey: 'synthetic-primary-order', activeStorage: 'A' }
          return {
            user,
            isStorageProvider: () => false,
            makeAvailable: async () => settings,
            getSettings: () => settings,
            findOrInsertUser: async () => ({ user: { ...user } }),
            setActive: async (_auth: unknown, activeStorage: string) => {
              if (first) {
                first = false
                entered.resolve()
                await release.promise
                if (failFirst) throw failure
              }
              user.activeStorage = activeStorage
            }
          }
        }
        const providers = ['A', 'B', 'C'].map((key, index) => provider(key, index + 1))
        const manager = new WalletStorageManager(
          'synthetic-primary-order',
          providers[0] as unknown as WalletStorageProvider,
          providers.slice(1) as unknown as WalletStorageProvider[]
        )
        await manager.makeAvailable()
        manager.syncToWriter = async (_auth, writer, source) => {
          const target = providers.find(
            p => p.getSettings().storageIdentityKey === writer.getSettings().storageIdentityKey
          )!
          const origin = providers.find(
            p => p.getSettings().storageIdentityKey === source!.getSettings().storageIdentityKey
          )!
          target.user.activeStorage = origin.user.activeStorage
          return { inserts: 0, updates: 0, log: '' }
        }
        const switching = manager.setActive('B')
        const checkedSwitch = failFirst ? expect(switching).rejects.toBe(failure) : switching
        await entered.promise
        let completed = 0
        const queued = requests.map(key =>
          manager.setActive(key).then(() => {
            completed++
          })
        )
        try {
          await new Promise<void>(resolve => setImmediate(resolve))
          expect(completed).toBe(0)
        } finally {
          release.resolve()
          await checkedSwitch
          await Promise.all(queued)
        }
        const expected = requests[requests.length - 1]
        expect(manager.getActiveStore()).toBe(expected)
        expect(manager.isActiveEnabled).toBe(true)
        expect(providers.map(p => p.user.activeStorage)).toEqual([expected, expected, expected])
      }
    ),
    {
      numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
      seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
      ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {}),
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)
