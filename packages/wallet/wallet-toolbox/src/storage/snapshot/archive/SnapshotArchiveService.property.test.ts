import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { addSnapshotArchiveTables } from '../../schema/snapshotArchiveMigration'
import { addSnapshotArchiveRequestTable } from '../../schema/snapshotArchiveRequestMigration'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import { KnexSnapshotArchiveRequestStore } from './KnexSnapshotArchiveRequestStore'
import { snapshotArchiveTables, type SnapshotArchiveBinding } from './SnapshotArchive'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated creation/retry/close schedules preserve request identity, atomic publication and exact capacity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-request-property-'))
  const open = () =>
    knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'requests.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
  const db = open()
  const peer = open()
  try {
    await db.raw('PRAGMA journal_mode = WAL')
    await addSnapshotArchiveTables(db)
    await addSnapshotArchiveRequestTable(db)
    const requests = new KnexSnapshotArchiveRequestStore(db)
    const replacement = new KnexSnapshotArchiveRequestStore(peer)
    const archives = new KnexSnapshotArchiveStore(db)
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 0, max: 13 }),
        fc.integer({ min: 0, max: 3 }),
        fc.uint8Array({ minLength: 1, maxLength: 16 }),
        fc.constantFrom('failed' as const, 'closed' as const, 'resource-limited' as const),
        async (stage, prefix, retries, bytes, terminalState) => {
          const identityKey = '02' + bytes[0].toString(16).padStart(64, '0')
          const other = '03' + '11'.repeat(32)
          const notAfter = Date.now() + 300000
          const nonce = bytes[0].toString(16).padStart(64, '0')
          const requestId = createHash('sha256')
            .update(JSON.stringify(['wallet-snapshot-request/1', 1, nonce, notAfter, 32768]))
            .digest('hex')
          const request = { version: 1, nonce, notAfter, maxBytes: 32768, requestId }
          const admitted = await requests.claim(identityKey, request)
          expect(admitted.owner).toBeDefined()
          expect(admitted.receipt.state).toBe('building')
          for (let retry = 0; retry < retries; retry++)
            expect(await replacement.claim(identityKey, request)).toEqual({ receipt: admitted.receipt })
          const date = new Date('2026-01-01T00:00:00.000Z')
          const binding: SnapshotArchiveBinding = {
            version: 1,
            snapshotId: 'a'.repeat(64),
            sourceSchema: 'property-v1',
            sourceStorage: {
              created_at: date,
              updated_at: date,
              chain: 'test',
              dbtype: 'SQLite',
              storageIdentityKey: 'source',
              storageName: '',
              maxOutputScript: 1024
            },
            user: { created_at: date, updated_at: date, userId: 1, identityKey, activeStorage: 'source' }
          }
          if (stage > 0) {
            const writer = await requests.begin(admitted.owner!, binding)
            const pages = stage === 2 ? 13 : prefix
            for (const [sequence, table] of snapshotArchiveTables.slice(0, pages).entries()) {
              await archives.append(writer, { sequence, table, rows: bytes[0], done: true, bytes })
            }
            await expect(archives.inspect(identityKey, writer.archiveId)).rejects.toThrow('unavailable')
            if (stage === 2) {
              const manifest = await requests.seal(admitted.owner!, writer)
              const recovered = await replacement.claim(identityKey, request)
              expect(recovered).toEqual({
                receipt: { ...admitted.receipt, state: 'ready', archiveId: writer.archiveId, digest: manifest.digest }
              })
              expect(manifest.rows).toBe(13 * bytes[0])
              expect(manifest.expiresAt).toBe(notAfter)
              expect(
                (await new KnexSnapshotArchiveStore(peer).read(identityKey, writer.archiveId, bytes[0] % 13)).bytes
              ).toEqual(bytes)
            }
          }
          expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
          await replacement.close(other, requestId)
          await expect(replacement.status(other, requestId)).rejects.toThrow('unavailable')
          expect((await db('snapshot_archive_capacity').first()).archives).toBe(1)
          await replacement.close(identityKey, requestId, terminalState)
          await requests.close(identityKey, requestId)
          const terminal = (await requests.claim(identityKey, request)).receipt
          expect(terminal.state).toBe(terminalState)
          expect(terminal.archiveId).toBeUndefined()
          expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
          expect(await db('snapshot_archives')).toHaveLength(0)
          expect(await db('snapshot_archive_pages')).toHaveLength(0)
          const rows = await db('snapshot_archive_requests')
          expect(rows).toHaveLength(1)
          expect(Boolean(rows[0].released)).toBe(true)
          // Each generated case starts with an independent empty request history.
          await db('snapshot_archive_requests').delete()
        }
      )
    )
  } finally {
    await Promise.all([db.destroy(), peer.destroy()])
    await rm(directory, { recursive: true, force: true })
  }
})
