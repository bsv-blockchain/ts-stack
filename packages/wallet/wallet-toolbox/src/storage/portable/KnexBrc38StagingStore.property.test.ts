import fc from 'fast-check'
import { appendFile, chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  KnexBrc38StagingStore,
  type Brc38AuthenticatedImportReader,
  type KnexBrc38StagingLimits
} from './KnexBrc38StagingStore'
import type { PortableRow } from './Brc38PortableRows'
import { brc38StageTables, type Brc38StageRecord } from './Brc38SemanticStage'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { resumeBinding, resumeLimits } from './Brc38ResumeFixture'
import { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import {
  authenticatedStagePassword,
  authenticatedStageOptions,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
// The outer Jest guard retains this 150-second property failure limit plus
// 30 seconds for completion and physical cleanup; it does not renew owners.
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
const text = fc
  .array(fc.constantFrom('x', 'é', '中', '😀', '"', '\\', '\n'), {
    minLength: 1,
    maxLength: 24
  })
  .map(parts => parts.join(''))

// Independent JSON oracle: original fixture values are ordinary finite JSON.
// Do not call production canonical encoding or charge helpers to predict them.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(object)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonical(object[key]))
        .join(',') +
      '}'
    )
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Non-JSON synthetic oracle value')
  return encoded
}
function charge(record: Brc38StageRecord): number {
  return (
    Buffer.byteLength(canonical(record.row)) +
    128 +
    [...record.uniqueKeys, ...record.memberships].reduce(
      (sum, key) => sum + Buffer.byteLength(key.namespace) + Buffer.byteLength(key.key) + 128,
      0
    )
  )
}
async function parent() {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-property-knex-store-'))
  await chmod(directory, 0o700)
  if (process.env.TMPDIR === '/work/fixtures')
    await appendFile('/work/validation/fixture-record.jsonl', JSON.stringify({ path: directory }) + '\n')
  return directory
}
async function snapshot(store: KnexBrc38StagingStore) {
  return {
    metadata: await store.knex('metadata').where({ slot: 1 }).first(),
    counts: await store.knex('table_counts').orderBy('tableName'),
    rows: await store.knex('rows').orderBy('tableName').orderBy('position'),
    unique: await store.knex('unique_keys').orderBy('namespace').orderBy('key'),
    memberships: await store.knex('memberships').orderBy('namespace').orderBy('key')
  }
}
async function physical(store: KnexBrc38StagingStore) {
  expect((await stat(store.directory)).mode & 0o777).toBe(0o700)
  let bytes = 0
  for (const name of await readdir(store.directory)) {
    expect(['stage.sqlite', 'stage.sqlite-journal', 'brc38-owner.sqlite', 'brc38-owner.sqlite-journal']).toContain(name)
    const value = await stat(join(store.directory, name))
    expect(value.isFile()).toBe(true)
    expect(value.mode & 0o777).toBe(0o600)
    bytes += Math.max(value.size, value.blocks * 512)
  }
  expect(bytes).toBeLessThanOrEqual(store.limits.maximumPhysicalBytes)
  const values = await store.knex.raw('PRAGMA max_page_count')
  expect(values[0].max_page_count).toBe(Math.floor((store.limits.maximumPhysicalBytes - 65536) / (3 * 4096)))
  expect(await store.knex.raw('PRAGMA journal_mode')).toEqual([{ journal_mode: 'delete' }])
}

describe('real private Knex staging store generated accounting and ownership', () => {
  test('independent UTF8 charges, thirteen counters and late key rollback survive original owned replay and reopen', async () => {
    const directory = await parent()
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.constantFrom(...brc38StageTables), { minLength: 1, maxLength: 3 }),
          text,
          async (tables, suffix) => {
            const limits = resumeLimits(),
              binding = resumeBinding(),
              data = semanticStageFixture(),
              original = await KnexBrc38StagingStore.createOwned(directory, limits, binding),
              stores = [original]
            let current = original,
              handedOff = false,
              discarded = false
            try {
              const records: Brc38StageRecord[] = tables.map((table, i) => ({
                table,
                index: 0,
                row: data.tables[table][0],
                uniqueKeys: [{ namespace: 'generated-unique', key: i + ':' + suffix }],
                memberships: [{ namespace: 'generated-membership', key: suffix }]
              }))
              let logical = 0
              for (const record of records) {
                await current.append(record)
                logical += charge(record)
                expect((await snapshot(current)).metadata.logicalBytes).toBe(logical)
                expect(await current.row(record.table, 0)).toEqual(record.row)
              }
              const before = await snapshot(current)
              expect(before.metadata.rows).toBe(records.length)
              expect(before.counts).toEqual(
                [...brc38StageTables].sort().map(tableName => ({
                  tableName,
                  rows: tables.includes(tableName) ? 1 : 0
                }))
              )
              for (const record of records) {
                expect(await current.has(record.uniqueKeys[0].namespace, record.uniqueKeys[0].key)).toBe(true)
                await current.append(record)
              }
              expect(await snapshot(current)).toEqual(before)
              const first = records[0],
                insertedThenRolledBack = 'uncommitted:' + suffix
              await expect(
                current.append({
                  ...first,
                  index: 1,
                  uniqueKeys: [{ namespace: 'generated-unique', key: insertedThenRolledBack }, first.uniqueKeys[0]]
                })
              ).rejects.toThrow('UNIQUE')
              expect(await current.row(first.table, 1)).toBeUndefined()
              expect(await current.has('generated-unique', insertedThenRolledBack)).toBe(false)
              expect(await snapshot(current)).toEqual(before)
              await expect(current.append({ ...first, memberships: [] })).rejects.toThrow('committed prefix')
              expect(await snapshot(current)).toEqual(before)
              const header: typeof data = { ...data, tables: { ...data.tables } }
              for (const table of brc38StageTables) header.tables[table] = []
              const counts = Object.fromEntries(
                brc38StageTables.map(table => [table, tables.includes(table) ? 1 : 0])
              ) as Record<(typeof brc38StageTables)[number], number>
              await expect(current.seal(header, { ...counts, [first.table]: 2 })).rejects.toThrow('count mismatch')
              expect(await snapshot(current)).toEqual(before)
              await current.seal(header, counts)
              expect((await snapshot(current)).metadata.logicalBytes).toBe(
                logical + Buffer.byteLength(canonical(header))
              )
              const sealed = await snapshot(current)
              await current.seal(header, counts)
              for (const record of records) await current.append(record)
              expect(await snapshot(current)).toEqual(sealed)
              // This primitive-only seal is deliberately not an authenticated import.
              await expect(current.readImportPreview()).rejects.toThrow('authentication')
              await expect(current.withAuthenticatedPrivateDestination(async () => undefined)).rejects.toThrow(
                'authentication'
              )
              await physical(current)
              const file = await stat(join(current.directory, 'stage.sqlite'))
              await current.close()
              handedOff = true
              await expect(current.discard(new Error('stale owner'))).rejects.toThrow('handed off')
              await expect(
                KnexBrc38StagingStore.reopenOwned(current.directory, limits, {
                  ...binding,
                  targetGeneration: binding.targetGeneration + 1
                })
              ).rejects.toThrow('binding')
              current = await KnexBrc38StagingStore.reopenOwned(current.directory, limits, binding)
              stores.push(current)
              handedOff = false
              expect(current.limits.expiresAt).toBe(limits.expiresAt)
              const reopened = await stat(join(current.directory, 'stage.sqlite'))
              expect([reopened.dev, reopened.ino]).toEqual([file.dev, file.ino])
              expect(await snapshot(current)).toEqual(sealed)
              await current.discard(new Error('completed synthetic component'))
              discarded = true
              await current.discard(new Error('idempotent cleanup'))
              expect(await readdir(directory)).toEqual([])
            } finally {
              if (!discarded) {
                if (handedOff) {
                  current = await KnexBrc38StagingStore.reopenOwned(original.directory, limits, binding)
                  stores.push(current)
                }
                await current.discard(new Error('generated component cleanup'))
              }
              for (const store of stores) await store.close()
            }
          }
        ),
        controls
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180000)

  test('generated quota, allocation and coordinate refusals preserve every original counter and indexed row', async () => {
    const directory = await parent()
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('logical', 'rows', 'serialized', 'allocation', 'keys', 'order'),
          text,
          async (kind, description) => {
            const row = { ...semanticStageFixture().tables.transactions[0], description },
              record: Brc38StageRecord = {
                table: 'transactions',
                index: 0,
                row,
                uniqueKeys: [],
                memberships: []
              },
              override: Partial<KnexBrc38StagingLimits> =
                kind === 'logical'
                  ? { maximumLogicalBytes: charge(record) }
                  : kind === 'rows'
                    ? { maximumRows: 1 }
                    : kind === 'serialized'
                      ? { maximumRowBytes: Buffer.byteLength(canonical(row)) - 1 }
                      : kind === 'allocation'
                        ? { maximumRowAllocationBytes: 1 }
                        : {},
              store = await KnexBrc38StagingStore.create(directory, {
                ...resumeLimits(),
                ...override
              })
            try {
              if (kind === 'logical' || kind === 'rows') await store.append(record)
              const before = await snapshot(store)
              const rejected =
                kind === 'logical' || kind === 'rows'
                  ? { ...record, index: 1 }
                  : kind === 'keys'
                    ? { ...record, uniqueKeys: [{ namespace: 'x'.repeat(65), key: description }] }
                    : kind === 'order'
                      ? { ...record, index: 1 }
                      : record
              await expect(store.append(rejected)).rejects.toThrow()
              expect(await snapshot(store)).toEqual(before)
              expect(await store.count('transactions')).toBe(kind === 'logical' || kind === 'rows' ? 1 : 0)
              expect(await store.row('transactions', 1)).toBeUndefined()
              await physical(store)
            } finally {
              await store.discard(new Error('generated refusal cleanup'))
            }
            expect(await readdir(directory)).toEqual([])
          }
        ),
        controls
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180000)

  test('real independent authentication binds preview charges and drains reads before physical owner handoff', async () => {
    const directory = await parent(),
      root = await Brc38StagingAdmissionNode.create(directory, {
        maximumImports: 1,
        maximumPhysicalBytes: 7340032,
        maximumLogicalBytes: 1048576
      }),
      data = semanticStageFixture(),
      bytes = await encrypted(data),
      selected = authenticatedStageOptions(bytes)
    async function* source() {
      for (let offset = 0; offset < bytes.length; offset += 127) yield bytes.slice(offset, offset + 127)
    }
    let reservation = await stageAuthenticatedBrc39PrivateImport(source(), authenticatedStagePassword, root, selected)
    const originalDirectory = reservation.reservation.store.directory,
      originalExpiry = reservation.reservation.store.limits.expiresAt,
      initial = await snapshot(reservation.reservation.store),
      stores = [reservation.reservation.store]
    try {
      expect(initial.metadata.state).toBe('sealed')
      expect(initial.metadata.rows).toBe(13)
      expect(reservation.archiveSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      await fc.assert(
        fc.asyncProperty(text, fc.constantFrom(...brc38StageTables), fc.boolean(), async (value, table, handoff) => {
          const store = reservation.reservation.store,
            preview = JSON.stringify({ description: value })
          await store.saveImportPreview(preview)
          expect(await store.readImportPreview()).toBe(preview)
          expect((await snapshot(store)).metadata.logicalBytes).toBe(
            initial.metadata.logicalBytes + Buffer.byteLength(preview) + 64
          )
          const saved = await snapshot(store),
            receipt = await store.knex('private_import').where({ slot: 1 }).first()
          expect(receipt.previewSha256).toBe(createHash('sha256').update(preview).digest('hex'))
          await store.saveImportPreview(preview)
          expect(await snapshot(store)).toEqual(saved)
          await expect(store.saveImportPreview('x'.repeat(8193))).rejects.toThrow('bounds')
          expect(await snapshot(store)).toEqual(saved)
          let escaped: Readonly<Brc38AuthenticatedImportReader> | undefined,
            pending: Promise<Readonly<PortableRow> | undefined> | undefined,
            settled = false
          await store.withAuthenticatedImportRead(async (json, metadata, reader) => {
            escaped = reader
            expect(json).toBe(preview)
            expect(metadata.rows).toBe(13)
            expect(Object.isFrozen(reader) && Object.isFrozen(metadata)).toBe(true)
            expect(await reader.count(table)).toBe(1)
            const header = await reader.header()
            expect(header.sourceStorage).toEqual(data.sourceStorage)
            // An actual SQL read is intentionally left pending at callback return.
            // The original owner must drain it before returning the outer promise.
            pending = reader.row(table, 0).then(row => {
              settled = true
              return row
            })
            await expect(store.close()).rejects.toThrow('Wait for owned')
          })
          expect(settled).toBe(true)
          expect(await pending).toEqual(data.tables[table][0])
          await expect(escaped!.count(table)).rejects.toThrow('unavailable')
          const cause = new Error('synthetic preview callback ' + value)
          await expect(
            store.prepareImportPreview(async () => {
              throw cause
            })
          ).rejects.toBe(cause)
          expect(await snapshot(store)).toEqual(saved)
          expect(store.limits.expiresAt).toBe(originalExpiry)
          expect((await root.usage()).imports).toBe(1)
          if (handoff) {
            const file = await stat(join(originalDirectory, 'stage.sqlite'))
            await store.close()
            const next = await root.resume(reservation.reservation.id, selected.limits, selected.binding)
            stores.push(next.store)
            reservation = { ...reservation, reservation: next }
            const after = await stat(join(originalDirectory, 'stage.sqlite'))
            expect([after.dev, after.ino]).toEqual([file.dev, file.ino])
            expect(next.store.limits.expiresAt).toBe(originalExpiry)
            expect(await snapshot(next.store)).toEqual(saved)
            expect(await next.store.readImportPreview()).toBe(preview)
          }
        }),
        controls
      )
      await root.discard(reservation.reservation, new Error('completed generated authenticated reads'))
      expect((await root.usage()).imports).toBe(0)
      expect(await readdir(directory)).toEqual(['brc38-admission.sqlite'])
    } finally {
      for (const store of stores) await store.close()
      await root.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 180000)
})
