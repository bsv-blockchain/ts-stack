import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { knex } from 'knex'
import { addSnapshotArchiveTables } from '../../schema/snapshotArchiveMigration'
import {
  KnexSnapshotArchiveStore,
  snapshotArchiveTables,
  type SnapshotArchiveBinding
} from './KnexSnapshotArchiveStore'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const identity = '02' + '11'.repeat(32)
const other = '03' + '22'.repeat(32)
const date = new Date('2026-01-01T00:00:00.000Z')
const binding: SnapshotArchiveBinding = {
  version: 1,
  snapshotId: 'a'.repeat(64),
  sourceSchema: 'property-v1',
  sourceStorage: {
    created_at: date,
    updated_at: date,
    storageIdentityKey: 'original',
    storageName: 'source',
    chain: 'test',
    dbtype: 'SQLite',
    maxOutputScript: 1024
  },
  user: { userId: 1, identityKey: identity, activeStorage: 'historical', created_at: date, updated_at: date }
}
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

// The model uses Node's independent hash implementation and only the persisted
// public receipts; it does not call the store's hashing/accounting helpers.
test('generated capture schedules preserve immutable receipts and reserve capacity through cancellation or expiry', async () => {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  const store = new KnexSnapshotArchiveStore(db)
  try {
    await addSnapshotArchiveTables(db)
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            bytes: fc.uint8Array({ minLength: 1, maxLength: 96 }),
            rows: fc.integer({ min: 0, max: 7 }),
            replay: fc.boolean(),
            reconnect: fc.boolean()
          }),
          { minLength: 13, maxLength: 13 }
        ),
        fc.integer({ min: 4097, max: 16000 }),
        fc.integer({ min: -1, max: 13 }),
        fc.boolean(),
        async (pages, reservation, cancelAfter, expire) => {
          let used = new TextEncoder().encode(JSON.stringify(binding)).length + 4096
          if (reservation < used) {
            await expect(store.begin(binding, { maxBytes: reservation })).rejects.toThrow('metadata')
            expect(await db('snapshot_archives')).toHaveLength(0)
            return
          }
          const writer = await store.begin(binding, { maxBytes: reservation })
          let active = store
          let expectedDigest = digest(JSON.stringify(binding))
          let rows = 0
          let accepted = 0
          try {
            for (const [sequence, generated] of pages.entries()) {
              if (cancelAfter === sequence) return
              if (generated.reconnect) active = new KnexSnapshotArchiveStore(db)
              const page = {
                sequence,
                table: snapshotArchiveTables[sequence],
                rows: generated.rows,
                done: true,
                bytes: generated.bytes
              }
              const charge = generated.bytes.length + 512
              if (used + charge > reservation) {
                const before = await db('snapshot_archives').first()
                await expect(active.append(writer, page)).rejects.toThrow('reservation exhausted')
                expect(await db('snapshot_archives').first()).toEqual(before)
                return
              }
              await active.append(writer, page)
              accepted++
              used += charge
              rows += generated.rows
              expectedDigest = digest(
                JSON.stringify([expectedDigest, sequence, page.table, page.rows, true, digest(page.bytes)])
              )
              if (generated.replay) await active.append(writer, page)
              const persisted = await db('snapshot_archives').first()
              expect(persisted).toMatchObject({
                nextSequence: accepted,
                tableIndex: accepted,
                usedBytes: used,
                rows,
                digest: expectedDigest
              })
              expect(await db('snapshot_archive_pages')).toHaveLength(accepted)
              await expect(active.inspect(identity, writer.archiveId)).rejects.toThrow('unavailable')
            }
            if (cancelAfter === 13) return
            const manifest = await active.seal(writer)
            expect(manifest).toMatchObject({ pages: 13, rows, digest: expectedDigest, binding })
            await active.close(other, writer.archiveId)
            for (const [sequence, generated] of pages.entries()) {
              const received = await new KnexSnapshotArchiveStore(db).read(identity, writer.archiveId, sequence)
              expect(received).toMatchObject({
                bytes: generated.bytes,
                rows: generated.rows,
                digest: digest(generated.bytes),
                done: true,
                table: snapshotArchiveTables[sequence]
              })
            }
            if (expire) {
              await db('snapshot_archives').where({ archiveId: writer.archiveId }).update({ expiresAt: 0 })
              await expect(active.inspect(identity, writer.archiveId)).rejects.toThrow('unavailable')
              await expect(active.read(identity, writer.archiveId, 0)).rejects.toThrow('unavailable')
            }
          } finally {
            expect(await db('snapshot_archive_capacity').first()).toMatchObject({
              archives: 1,
              reservedBytes: reservation
            })
            await new KnexSnapshotArchiveStore(db).close(identity, writer.archiveId)
            expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
            expect(await db('snapshot_archives')).toHaveLength(0)
            expect(await db('snapshot_archive_pages')).toHaveLength(0)
          }
        }
      )
    )
  } finally {
    await db.destroy()
  }
}, 60000)
