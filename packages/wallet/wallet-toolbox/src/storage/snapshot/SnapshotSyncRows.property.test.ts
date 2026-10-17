import fc from 'fast-check'
import { knex } from 'knex'
import { loadSnapshotIdMap } from './SnapshotSyncRows'
import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('random overlapping parent IDs preserve exact profile/source maps and persist only learned child IDs', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await database.schema.createTable('snapshot_sync_ids', table => {
      table.integer('userId')
      table.string('sourceStorageIdentityKey')
      table.string('entity')
      table.integer('incomingId')
      table.integer('localId')
      table.primary(['userId', 'sourceStorageIdentityKey', 'entity', 'incomingId'])
    })
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 10000 }),
        fc.boolean(),
        async (incoming, userId, second) => {
          await database('snapshot_sync_ids').delete()
          const scope = { userId, sourceStorageIdentityKey: second ? 'second' : 'first' }
          const original = incoming.flatMap((id, index) => [
            { ...scope, entity: 'transaction', incomingId: id, localId: index + 101 },
            { ...scope, userId: userId + 1, entity: 'transaction', incomingId: id, localId: index + 201 },
            {
              ...scope,
              sourceStorageIdentityKey: second ? 'first' : 'second',
              entity: 'transaction',
              incomingId: id,
              localId: index + 301
            }
          ])
          await database('snapshot_sync_ids').insert(original)
          const chunk = {
            userIdentityKey: 'identity',
            fromStorageIdentityKey: scope.sourceStorageIdentityKey,
            toStorageIdentityKey: 'destination',
            outputs: incoming.map(id => ({ userId: 77, outputId: id, transactionId: id, spentBy: id }))
          } as SyncChunk
          const loaded = await loadSnapshotIdMap(database, scope, 77, 'outputs', chunk)
          expect(loaded.map.transaction.idMap).toEqual(
            Object.fromEntries(incoming.map((id, index) => [id, index + 101]))
          )
          expect(loaded.map.output.idMap).toEqual({})
          for (const [index, id] of incoming.entries()) loaded.map.output.idMap[id] = index + 401
          await loaded.persist()
          expect(
            await database('snapshot_sync_ids')
              .where({ entity: 'transaction' })
              .orderBy(['userId', 'sourceStorageIdentityKey', 'incomingId'])
          ).toEqual(
            [...original].sort(
              (a, b) =>
                a.userId - b.userId ||
                a.sourceStorageIdentityKey.localeCompare(b.sourceStorageIdentityKey) ||
                a.incomingId - b.incomingId
            )
          )
          expect(
            await database('snapshot_sync_ids')
              .where({ ...scope, entity: 'output' })
              .orderBy('incomingId')
          ).toEqual(
            incoming
              .map((id, index) => ({ ...scope, entity: 'output', incomingId: id, localId: index + 401 }))
              .sort((a, b) => a.incomingId - b.incomingId)
          )
          expect(await database('snapshot_sync_ids')).toHaveLength(incoming.length * 4)
          const missing = { ...chunk, outputs: [{ userId: 77, outputId: 100001, transactionId: 100001 }] } as SyncChunk
          await expect(loadSnapshotIdMap(database, scope, 77, 'outputs', missing)).rejects.toThrow(
            'parent mapping is missing'
          )
          expect(await database('snapshot_sync_ids')).toHaveLength(incoming.length * 4)
        }
      )
    )
  } finally {
    await database.destroy()
  }
}, 120000)
