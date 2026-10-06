import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { decodeSyncTransfer } from '../../remoting/SyncTransfer'
import { captureKnexSnapshotArchive } from './captureKnexSnapshotArchive'
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

test('generated SQL captures match the selected profile or leave no readable state after cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-capture-property-'))
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
  const writer = open()
  const reader = open()
  try {
    await writer.knex.raw('PRAGMA journal_mode = WAL')
    await writer.migrate('generated capture', 'generated-source')
    await writer.makeAvailable()
    await reader.makeAvailable()
    const { user: first } = await writer.findOrInsertUser(identity)
    const { user: second } = await writer.findOrInsertUser(other)
    const store = new KnexSnapshotArchiveStore(writer.knex)
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 10000 }), { maxLength: 8 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 10000 }), { maxLength: 8 }),
        fc.boolean(),
        fc.integer({ min: -1, max: 14 }),
        async (firstLabels, secondLabels, chooseSecond, cancelAfter) => {
          await writer.knex('tx_labels').delete()
          const rows = [
            ...firstLabels.map(label => ({ userId: first.userId, label: `first-${label}` })),
            ...secondLabels.map(label => ({ userId: second.userId, label: `second-${label}` }))
          ].map(row => ({
            ...row,
            isDeleted: row.label.endsWith('0'),
            created_at: date.toISOString(),
            updated_at: date.toISOString()
          }))
          if (rows.length > 0) await writer.knex('tx_labels').insert(rows)
          const selected = chooseSecond ? second : first
          const expected = rows
            .filter(row => row.userId === selected.userId)
            .map(row => ({ label: row.label, isDeleted: row.isDeleted }))
          const signal = new AbortController()
          if (cancelAfter === 0) signal.abort()
          const seen: number[] = []
          const pending = captureKnexSnapshotArchive(reader, writer.knex, selected.identityKey, 'test', {
            signal: signal.signal,
            onProgress: progress => {
              seen.push(progress.pages)
              if (progress.pages === cancelAfter) signal.abort()
              progress.pages = -100 // A consumer cannot mutate the controller's cursor.
            }
          })
          if (cancelAfter >= 0 && cancelAfter <= 13) await expect(pending).rejects.toThrow('cancelled')
          else {
            const manifest = await pending
            expect(manifest.pages).toBe(13)
            expect(manifest.binding.user.identityKey).toBe(selected.identityKey)
            const page = await store.read(selected.identityKey, manifest.archiveId, 8)
            const frame = decodeSyncTransfer(page.bytes) as {
              table: string
              rows: Array<{ label: string; isDeleted: boolean }>
            }
            expect(frame.table).toBe('txLabels')
            expect(frame.rows.map(row => ({ label: row.label, isDeleted: row.isDeleted }))).toEqual(expected)
            await expect(store.read(chooseSecond ? identity : other, manifest.archiveId, 8)).rejects.toThrow(
              'unavailable'
            )
            await store.close(selected.identityKey, manifest.archiveId)
          }
          expect(seen).toEqual(Array.from({ length: seen.length }, (_, index) => index + 1))
          expect(await writer.knex('snapshot_archives')).toHaveLength(0)
          expect(await writer.knex('snapshot_archive_pages')).toHaveLength(0)
          expect(await writer.knex('snapshot_archive_capacity').first()).toMatchObject({
            archives: 0,
            reservedBytes: 0
          })
        }
      ),
      { seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 5442026 }
    )
  } finally {
    await reader.destroy()
    await writer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)

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
