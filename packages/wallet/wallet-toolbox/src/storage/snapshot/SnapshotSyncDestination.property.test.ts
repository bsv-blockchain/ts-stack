import fc from 'fast-check'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import type { SnapshotSyncSource } from './SnapshotSync'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('random profile bindings reject same-view drift without changing durable checkpoints or another profile', async () => {
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  })
  const identities = ['02' + '11'.repeat(32), '03' + '22'.repeat(32)]
  try {
    await storage.migrate('destination', 'destination')
    await storage.makeAvailable()
    const writer = storage.getSnapshotSync()!
    const users = []
    for (const identity of identities) users.push((await storage.findOrInsertUser(identity)).user)
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.integer({ min: 1, max: 1000000 }),
        fc.integer({ min: 1, max: 1000000 }),
        fc.constantFrom('userId', 'created_at', 'updated_at', 'activeStorage', 'expiresAt'),
        async (second, sourceId, epoch, field) => {
          await storage.knex('snapshot_sync_sessions').delete()
          const selected = Number(second)
          const date = new Date(1600000000000 + epoch)
          const source: SnapshotSyncSource = {
            version: 1,
            snapshotId: 'a'.repeat(64),
            sourceStorage: { ...storage.getSettings(), storageIdentityKey: 'source' },
            user: { ...users[selected], userId: sourceId, created_at: date, updated_at: date, activeStorage: 'source' },
            expiresAt: Date.now() + 600000
          }
          const other: SnapshotSyncSource = {
            ...source,
            user: { ...source.user, identityKey: identities[1 - selected] }
          }
          const otherCheckpoint = await writer.begin(other, 'source')
          const checkpoint = await writer.begin(source, 'source')
          expect(checkpoint.identityKey).toBe(identities[selected])
          expect(await writer.begin(source, 'source')).toEqual(checkpoint)
          const changed = { ...source, user: { ...source.user } }
          if (field === 'userId') changed.user.userId++
          else if (field === 'created_at' || field === 'updated_at') changed.user[field] = new Date(date.getTime() + 1)
          else if (field === 'activeStorage') changed.user.activeStorage = 'changed-primary'
          else changed.expiresAt++
          await expect(writer.begin(changed, changed.user.activeStorage)).rejects.toThrow('binding changed')
          expect(await writer.checkpoint(identities[selected], 'source')).toEqual(checkpoint)
          expect(await writer.checkpoint(identities[1 - selected], 'source')).toEqual(otherCheckpoint)
          expect(await storage.knex('snapshot_sync_ids')).toHaveLength(0)
          const replacement = await writer.begin({ ...source, snapshotId: 'b'.repeat(64) }, 'source')
          expect(replacement).toMatchObject({ snapshotId: 'b'.repeat(64), sequence: 0, tableIndex: 0, done: false })
          expect(replacement.sessionId).not.toBe(checkpoint.sessionId)
          expect(await writer.checkpoint(identities[1 - selected], 'source')).toEqual(otherCheckpoint)
        }
      )
    )
  } finally {
    await storage.destroy()
  }
}, 120000)
