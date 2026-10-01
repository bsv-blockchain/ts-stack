import fc from 'fast-check'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex } from 'knex'
import { addSnapshotArchiveTables } from '../../schema/snapshotArchiveMigration'
import { addSnapshotArchiveRequestTable } from '../../schema/snapshotArchiveRequestMigration'
import { addSnapshotArchiveOwnerTable } from '../../schema/snapshotArchiveOwnerMigration'
import { addSnapshotArchiveGuardTable } from '../../schema/snapshotArchiveGuardMigration'
import { readGuardedSnapshotArchive, recoverSnapshotArchiveGuards } from './SnapshotArchiveGuard'
import * as ArchiveSql from './SnapshotArchiveSql'
import { SnapshotArchiveCleanupPendingError } from './SnapshotArchiveOwner'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import { KnexSnapshotArchiveRequestStore } from './KnexSnapshotArchiveRequestStore'
import { snapshotArchiveTables, type SnapshotArchiveBinding, type SnapshotArchiveWriter } from './SnapshotArchive'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated guarded-owner schedules keep quota through native close and fence each successor claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-guard-property-'))
  const config = {
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'guards.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  }
  const db = knex(config)
  const peer = knex(config)
  const requests = new KnexSnapshotArchiveRequestStore(db, true, true)
  const replacement = new KnexSnapshotArchiveRequestStore(peer, true, true)
  const databaseNow = ArchiveSql.snapshotArchiveDatabaseNow
  let expiredAt: number | undefined
  const clock = jest
    .spyOn(ArchiveSql, 'snapshotArchiveDatabaseNow')
    .mockImplementation(async k => expiredAt ?? (await databaseNow(k)))
  const recover = async () => {
    await recoverSnapshotArchiveGuards(peer, config)
    await replacement.reap()
  }
  const gate = () => {
    let resolve!: () => void
    const promise = new Promise<void>(done => {
      resolve = done
    })
    return { promise, resolve }
  }
  try {
    await db.raw('PRAGMA journal_mode = WAL')
    await addSnapshotArchiveTables(db)
    await addSnapshotArchiveRequestTable(db)
    await addSnapshotArchiveOwnerTable(db)
    await addSnapshotArchiveGuardTable(db)
    await db.schema.createTable('guard_values', table => {
      table.integer('id').primary()
      table.integer('value')
    })
    await db('guard_values').insert({ id: 1, value: 0 })
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000000 }),
        fc.boolean(),
        fc.array(fc.constantFrom('recover', 'wrong-ack', 'write'), { minLength: 0, maxLength: 4 }),
        async (value, expire, schedule) => {
          const identityKey = '02' + '77'.repeat(32)
          const offered = (await requests.offer(identityKey, { lifetimeMs: 300000, maxBytes: 32768 }))!
          const { owner } = await requests.claimReader(identityKey, offered.request)
          await db('guard_values').update({ value })
          const source = knex(config)
          const opened = gate(),
            stop = gate(),
            closing = gate(),
            finish = gate()
          const destroy = source.client.destroyRawConnection.bind(source.client)
          source.client.destroyRawConnection = async connection => {
            closing.resolve()
            await finish.promise
            await destroy(connection)
          }
          const work = readGuardedSnapshotArchive(db, source, owner!, async trx => {
            expect((await trx('guard_values').first()).value).toBe(value)
            opened.resolve()
            await stop.promise
            expect((await trx('guard_values').first()).value).toBe(value)
          })
          void work.catch(() => undefined)
          try {
            await opened.promise
            if (expire) expiredAt = offered.request.notAfter
            else await replacement.markReaderCancellation(identityKey, offered.request)
            for (const action of schedule) {
              if (action === 'recover') await recover()
              else if (action === 'wrong-ack') await replacement.sourceClosed({ ...owner!, claimToken: 'incorrect' })
              else await peer('guard_values').update({ value: value + 1 })
              expect(Number((await db('snapshot_archive_capacity').first()).archives)).toBe(1)
            }
            stop.resolve()
            await closing.promise
            await recover()
            expect(await db('snapshot_archive_owners').first()).toMatchObject(owner!)
            expect(Number((await db('snapshot_archive_capacity').first()).archives)).toBe(1)
            finish.resolve()
            await work
            await recover()
            expect(await db('snapshot_archive_owners')).toHaveLength(0)
            expect(Number((await db('snapshot_archive_capacity').first()).archives)).toBe(0)
            await expect(requests.claimReader(identityKey, offered.request)).rejects.toThrow(
              expire ? 'Invalid snapshot archive reader request' : 'unavailable'
            )
            expect((await db('guard_values').first()).value).toBe(schedule.includes('write') ? value + 1 : value)
            const next = (await requests.offer(identityKey, { lifetimeMs: 300000, maxBytes: 32768 }))!
            const successor = await requests.claimReader(identityKey, next.request)
            await replacement.sourceClosed(owner!)
            expect(await db('snapshot_archive_owners').first()).toMatchObject(successor.owner!)
            await replacement.markReaderCancellation(identityKey, next.request)
            await recover()
            expect(Number((await db('snapshot_archive_capacity').first()).archives)).toBe(0)
          } finally {
            stop.resolve()
            finish.resolve()
            await work.catch(() => undefined)
            await source.destroy()
            expiredAt = undefined
          }
        }
      )
    )
  } finally {
    clock.mockRestore()
    await Promise.all([db.destroy(), peer.destroy()])
    await rm(directory, { recursive: true, force: true })
  }
})

test('generated remote cancellation schedules retain source quota until exact cleanup acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-owner-property-'))
  const open = () =>
    knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'owners.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
  const db = open()
  const peer = open()
  try {
    await db.raw('PRAGMA journal_mode = WAL')
    await addSnapshotArchiveTables(db)
    await addSnapshotArchiveRequestTable(db)
    await addSnapshotArchiveOwnerTable(db)
    const requests = new KnexSnapshotArchiveRequestStore(db, true)
    const replacement = new KnexSnapshotArchiveRequestStore(peer, true)
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 13 }),
        fc.array(fc.constantFrom('retry', 'reap', 'wrong-ack'), { minLength: 0, maxLength: 5 }),
        fc.uint8Array({ minLength: 1, maxLength: 16 }),
        async (pages, schedule, bytes) => {
          const identityKey = '02' + bytes[0].toString(16).padStart(64, '0')
          const issued = (await requests.offer(identityKey, { lifetimeMs: 300000, maxBytes: 32768 }))!
          const { owner } = await requests.claimReader(identityKey, issued.request)
          const date = new Date('2026-01-01T00:00:00.000Z')
          let writer: SnapshotArchiveWriter | undefined
          if (pages > 0) {
            writer = await requests.begin(owner!, {
              version: 1,
              snapshotId: 'a'.repeat(64),
              sourceSchema: 'owner-property-v1',
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
            })
            for (const [sequence, table] of snapshotArchiveTables.slice(0, pages).entries())
              await requests.append(owner!, writer, { sequence, table, rows: 0, done: true, bytes })
          }
          await replacement.markReaderCancellation(identityKey, issued.request)
          for (const action of schedule) {
            if (action === 'retry')
              expect((await requests.claimReader(identityKey, issued.request)).receipt.state).toBe('closed')
            else if (action === 'reap') await replacement.reap()
            else await replacement.sourceClosed({ ...owner!, claimToken: 'wrong-claim-token' })
          }
          await expect(replacement.close(identityKey, issued.request.requestId)).rejects.toBeInstanceOf(
            SnapshotArchiveCleanupPendingError
          )
          expect(await db('snapshot_archive_owners')).toHaveLength(1)
          expect(await db('snapshot_archive_pages')).toHaveLength(pages)
          expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 1, reservedBytes: 32768 })
          if (writer !== undefined)
            await expect(
              requests.append(owner!, writer, {
                sequence: 0,
                table: snapshotArchiveTables[0],
                rows: 0,
                done: true,
                bytes
              })
            ).rejects.toThrow('unavailable')
          await requests.sourceClosed(owner!)
          await replacement.close(identityKey, issued.request.requestId)
          await replacement.close(identityKey, issued.request.requestId)
          await expect(requests.claimReader(identityKey, issued.request)).rejects.toThrow('unavailable')
          expect(await db('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
          expect(await db('snapshot_archive_owners')).toHaveLength(0)
          expect(await db('snapshot_archive_requests')).toHaveLength(0)
          expect(await db('snapshot_archives')).toHaveLength(0)
          expect(await db('snapshot_archive_pages')).toHaveLength(0)
        }
      )
    )
  } finally {
    await Promise.all([db.destroy(), peer.destroy()])
    await rm(directory, { recursive: true, force: true })
  }
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
