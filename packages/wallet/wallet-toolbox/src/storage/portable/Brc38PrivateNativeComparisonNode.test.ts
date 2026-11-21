import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { readBrc38ComposedDatabaseImage } from './Brc38ComposedDatabaseImageNode'
import { withBrc38PrivateContentVersion } from './Brc38PrivateContentVersionNode'
import { collectBrc38NativePackedContent } from './Brc38NativePackedTextFieldsNode'
import { nativeTestExecutable } from './Brc38NativeTestPath'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { installBrc38PrivateNativeCandidateSchema } from './Brc38PrivateNativeRestoreNode'
import { registerBrc38PrivateDestinationLease } from './Brc38PrivateDestinationLeaseNode'
import { withBrc38KnexImportReadDestination } from './Brc38KnexDestinationFence'

// UNRUN actual factory/kernel lifecycle cases. This small synthetic SQL table
// proves admission and physical resume only; it does not qualify an all47 merge,
// reconstructed fields, a publication copy or primary selection.
describe('actual private native comparison phase', () => {
  let fixture: Awaited<ReturnType<typeof previewPrivateFixture>> | undefined
  afterEach(async () => {
    await fixture?.close()
    fixture = undefined
  })
  async function open(streamedStructured = false) {
    fixture = streamedStructured
      ? await previewPrivateFixture(undefined, undefined, 65536, 16777216, 16777216, true)
      : await previewPrivateFixture()
    const { root, selected, value } = fixture
    await value.reservation.store.close()
    const reservation = await root.resumeNative(
      value.reservation.id,
      selected.limits,
      selected.binding,
      nativeTestExecutable()
    )
    fixture.held.push(reservation)
    const store = reservation.store
    await store.knex.raw('CREATE TABLE comparison_probe(id INTEGER PRIMARY KEY,value TEXT NOT NULL)')
    await store.knex('comparison_probe').insert({ id: 1, value: 'original semantic data' })
    return { store, root, selected, id: reservation.id }
  }
  test('fresh negotiation needs drained writers; frozen rows and schemas cannot change and existing reads/settlement remain', async () => {
    const { store } = await open()
    await expect(store.requirePrivateNativeComparison()).rejects.toThrow('comparison phase')
    await store.knex.transaction(async writer => {
      await expect(store.beginPrivateNativeComparison()).rejects.toThrow('drained writers')
      await writer('comparison_probe').where({ id: 1 }).update({ value: 'prepared original data' })
    })
    await store.beginPrivateNativeComparison()
    await store.beginPrivateNativeComparison()
    await store.requirePrivateNativeComparison()
    const expected = [{ id: 1, value: 'prepared original data' }]
    for (const effect of [
      () => store.knex('comparison_probe').where({ id: 1 }).update({ value: 'changed' }),
      () => store.knex('comparison_probe').where({ id: 1 }).delete(),
      () => store.knex('comparison_probe').insert({ id: 2, value: 'new' }),
      () => store.knex.raw('DROP TABLE comparison_probe'),
      () => store.knex.raw('ALTER TABLE comparison_probe ADD COLUMN other TEXT'),
      () => store.knex.raw('CREATE TEMP TABLE cannot_add_schema(id INTEGER)'),
      () => store.knex.raw('PRAGMA writable_schema=ON')
    ]) {
      await expect(effect()).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
      expect(await store.knex('comparison_probe').orderBy('id')).toEqual(expected)
    }
    await store.knex.transaction(async reader => {
      expect(await reader('comparison_probe').select('*')).toEqual(expected)
    })
    await store.requirePrivateNativeComparison()
  })
  test('frozen authenticated structured validation uses a drained physical query-only lease without reopening writer settings', async () => {
    const { store, selected } = await open(true)
    const stopped = new Error('Independent structured read callback completed')
    await store.beginPrivateNativeComparison()
    await store.withAuthenticatedPrivateStructuredDestination(async (header, metadata) => {
      expect(header.user.identityKey).toBe(selected.binding.identityKey)
      expect(metadata.rows).toBeGreaterThan(0)
      await store.withPrivateNativeDatabase(true, async database => {
        await database.transaction(async reader => {
          store.assertPrivateNativeReadTransaction(reader)
          expect(await reader.raw('PRAGMA query_only')).toEqual([{ query_only: 1 }])
          expect(await reader('comparison_probe').select('*')).toEqual([{ id: 1, value: 'original semantic data' }])
          await expect(reader.raw('PRAGMA query_only=OFF')).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
          await expect(
            reader('comparison_probe').where({ id: 1 }).update({ value: 'not admitted' })
          ).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
        })
      })
      await expect(store.knex.raw('PRAGMA query_only=OFF')).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
    })
    await expect(store.withPrivateNativeDatabase(true, async () => {})).rejects.toThrow('authenticated receiver scope')
    await expect(
      store.withAuthenticatedPrivateStructuredDestination(async () => {
        throw stopped
      })
    ).rejects.toBe(stopped)
    await store.withAuthenticatedPrivateStructuredDestination(async () => {
      await store.withPrivateNativeDatabase(true, async database => {
        expect(await database('comparison_probe').select('*')).toEqual([{ id: 1, value: 'original semantic data' }])
      })
    })
    await store.requirePrivateNativeComparison()
  }, 120000)
  test('physical original-reservation resume restores a new mutable kernel without renewing the original custody or expiry', async () => {
    const { store, root, selected, id } = await open(),
      originalBinding = await store.knex('private_binding').select('*')
    await store.beginPrivateNativeComparison()
    await store.close()
    await expect(store.beginPrivateNativeComparison()).rejects.toThrow()
    const resumed = await root.resumeNative(id, selected.limits, selected.binding, nativeTestExecutable())
    fixture!.held.push(resumed)
    expect(resumed.id).toBe(id)
    expect(resumed.store.limits).toEqual(selected.limits)
    expect(await resumed.store.knex('private_binding').select('*')).toEqual(originalBinding)
    await expect(resumed.store.requirePrivateNativeComparison()).rejects.toThrow('comparison phase')
    await resumed.store.knex('comparison_probe').where({ id: 1 }).update({ value: 'next original-owner attempt' })
    expect(await resumed.store.knex('comparison_probe').select('*')).toEqual([
      { id: 1, value: 'next original-owner attempt' }
    ])
    await resumed.store.beginPrivateNativeComparison()
    await expect(
      resumed.store.knex('comparison_probe').where({ id: 1 }).update({ value: 'cannot change frozen attempt' })
    ).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
  })
  test('full-schema frozen native preparation verifies its actual read mode without attempting forbidden setters', async () => {
    const { store, selected } = await open(true),
      storage = new StorageKnex({
        ...StorageProvider.createStorageBaseOptions(selected.binding.chain),
        knex: store.knex,
        snapshotSync: false
      }),
      selection = {
        identityKey: selected.binding.identityKey,
        chain: selected.binding.chain,
        targetStorageIdentityKey: selected.binding.targetStorageIdentityKey,
        mode: 'merge' as const
      }
    await store.withAuthenticatedPrivateStructuredDestination(async () => {
      await installBrc38PrivateNativeCandidateSchema(
        storage,
        store,
        selection.targetStorageIdentityKey,
        {
          receiptPolicy: previewReceiptPolicy,
          maximumStepRows: 16,
          maximumStepBytes: 65536,
          maximumMappedIds: 1000,
          maximumJournalLogicalBytes: 516096
        },
        true,
        true
      )
      registerBrc38PrivateDestinationLease(storage, store)
    })
    await store.beginPrivateNativeComparison()
    await store.withAuthenticatedPrivateStructuredDestination(async () => {
      const prepare = async () =>
        await withBrc38KnexImportReadDestination(storage, selection, previewReceiptPolicy, async (trx, actual) => {
          expect(actual).toMatchObject({ ...selection, userId: null, activeStorage: null })
          expect(await trx.raw('PRAGMA query_only')).toEqual([{ query_only: 1 }])
          expect(await trx('comparison_probe')).toEqual([{ id: 1, value: 'original semantic data' }])
          await expect(trx.raw('PRAGMA query_only=OFF')).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
          await expect(trx('comparison_probe').where({ id: 1 }).update({ value: 'forbidden' })).rejects.toMatchObject({
            code: 'SQLITE_AUTH'
          })
          return actual
        })
      const before = await prepare(),
        stopped = new Error('Independent native preparation failure')
      await expect(
        withBrc38KnexImportReadDestination(storage, selection, previewReceiptPolicy, async () => {
          throw stopped
        })
      ).rejects.toBe(stopped)
      expect(await prepare()).toEqual(before)
      expect(store.limits.expiresAt).toBe(selected.limits.expiresAt)
    })
    await store.requirePrivateNativeComparison()
    await expect(store.knex.raw('PRAGMA query_only=ON')).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
  }, 120000)
  test('frozen native comparison collects both scratch families while preserving semantic and progress guards', async () => {
    const { store, selected } = await open(true),
      storage = new StorageKnex({
        ...StorageProvider.createStorageBaseOptions(selected.binding.chain),
        knex: store.knex,
        snapshotSync: false
      }),
      expiresAt = Math.min(store.operationExpiresAt, Date.now() + 120000),
      check = () => store.assertPrivateNativeDestination(store.knex),
      fixture = {
        store,
        expiresAt,
        check,
        withRead: async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
          await store.withPrivateNativeDatabase(true, async database => await database.transaction(work)),
        withWriter: async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
          await store.withPrivateNativeDatabase(false, async database => await database.transaction(work))
      }
    await store.withAuthenticatedPrivateStructuredDestination(async () => {
      await installBrc38PrivateNativeCandidateSchema(
        storage,
        store,
        selected.binding.targetStorageIdentityKey,
        {
          receiptPolicy: previewReceiptPolicy,
          maximumStepRows: 16,
          maximumStepBytes: 65536,
          maximumMappedIds: 1000,
          maximumJournalLogicalBytes: 516096
        },
        true,
        true
      )
    })
    const protectedTables = [
      'rows',
      'metadata',
      'private_binding',
      'private_import',
      'users',
      'brc38_native_binary_fields',
      'brc38_native_text_fields',
      'snapshot_journal_clock'
    ]
    let before: unknown[][] = [],
      reservedBefore = 0
    await store.withAuthenticatedPrivateStructuredDestination(async () => {
      const working = new Brc38WorkingAllocation(fixture.store.limits.maximumRowAllocationBytes),
        descriptors: Array<{ family: 'binary' | 'raw-text'; bytes: Uint8Array; sha256: string }> = [
          { family: 'binary', bytes: new Uint8Array([65, 66]), sha256: '' },
          { family: 'raw-text', bytes: new Uint8Array([67, 68]), sha256: '' }
        ]
      for (const descriptor of descriptors) {
        descriptor.sha256 = createHash('sha256').update(descriptor.bytes).digest('hex')
        await withBrc38PrivateContentVersion(
          descriptor.family,
          fixture.store,
          { expiresAt: fixture.expiresAt, maximumBytes: 2, workingAllocation: working },
          { maximum: working.maximum, remaining: working.maximum },
          async version => {
            await version.begin({ bytes: 2, sha256: descriptor.sha256 })
            await version.append(0, descriptor.bytes.subarray(0, 1))
            await version.append(1, descriptor.bytes.subarray(1))
            await version.finish()
          }
        )
      }
      expect(working.used).toBe(0)
      before = await fixture.withRead(async trx => {
        const rows = []
        for (const table of protectedTables) rows.push(await trx(table).select('*'))
        return rows
      })
      reservedBefore = (
        await fixture.withRead(async trx => await trx('brc38_native_binary_budget').first('reservedBytes'))
      ).reservedBytes
    })
    await store.beginPrivateNativeComparison()
    await store.withAuthenticatedPrivateStructuredDestination(async () => {
      let chunks = 0,
        complete = false
      for (let pass = 0; pass < 4; pass++) {
        const result = await fixture.withWriter(async trx => {
          expect(await trx('brc38_native_text_gc_progress').select('*')).toEqual([{ slot: 1, nextFamily: pass % 2 }])
          const collected = await collectBrc38NativePackedContent(trx, 1)
          expect(await trx('brc38_native_text_gc_progress').select('*')).toEqual([
            { slot: 1, nextFamily: 1 - (pass % 2) }
          ])
          return collected
        })
        expect(result.chunks).toBe(1)
        chunks += result.chunks
        complete = result.complete
      }
      expect(chunks).toBe(4)
      expect(complete).toBe(true)
      await fixture.withWriter(async trx => {
        for (const table of [
          'brc38_native_binary_versions',
          'brc38_native_text_versions',
          'brc38_native_binary_chunks',
          'brc38_native_text_chunks',
          'brc38_native_binary_garbage',
          'brc38_native_text_garbage'
        ])
          expect(await trx(table)).toEqual([])
        expect((await trx('brc38_native_binary_budget').first('reservedBytes')).reservedBytes).toBeLessThan(
          reservedBefore
        )
        for (const effect of [
          () => trx('brc38_native_text_gc_progress').update({ slot: 1 }),
          () => trx('brc38_native_text_gc_progress').delete(),
          () => trx('brc38_native_text_gc_progress').insert({ slot: 1, nextFamily: 0 }),
          () => trx('users').update({ activeStorage: 'forbidden' }),
          () => trx('private_binding').delete(),
          () => trx('brc38_native_text_fields').delete(),
          () => trx('snapshot_journal_clock').update({ revision: 0 }),
          () => trx.raw('DROP TABLE brc38_native_text_gc_progress'),
          () => trx.raw('PRAGMA query_only=OFF')
        ])
          await expect(effect()).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
        await expect(trx('brc38_native_text_gc_progress').update({ nextFamily: 0 })).rejects.toThrow('must alternate')
        await expect(trx('brc38_native_text_gc_progress').update({ nextFamily: 2 })).rejects.toThrow()
        expect(await trx('brc38_native_text_gc_progress').select('*')).toEqual([{ slot: 1, nextFamily: 0 }])
      })
      await fixture.withRead(async trx => {
        for (let index = 0; index < protectedTables.length; index++)
          expect(await trx(protectedTables[index]).select('*')).toEqual(before[index])
      })
      await fixture.store.requirePrivateNativeComparison()
      fixture.check()
    })
  }, 120000)
  test.each([0, 1])(
    'quiescent frozen collector preserves the complete SQL image (%i retired chunks)',
    async chunks => {
      const fixture = await previewPrivateFixture(undefined, undefined, 65536, 16777216, 16777216, true)
      try {
        const { selected, value, root } = fixture
        await value.reservation.store.close()
        const reservation = await root.resumeNative(
          value.reservation.id,
          selected.limits,
          selected.binding,
          nativeTestExecutable()
        )
        fixture.held.push(reservation)
        const store = reservation.store,
          working = new Brc38WorkingAllocation(store.limits.maximumRowAllocationBytes),
          storage = new StorageKnex({
            ...StorageProvider.createStorageBaseOptions(selected.binding.chain),
            knex: store.knex,
            snapshotSync: false
          })
        await store.withAuthenticatedPrivateStructuredDestination(async () => {
          await installBrc38PrivateNativeCandidateSchema(
            storage,
            store,
            selected.binding.targetStorageIdentityKey,
            {
              receiptPolicy: previewReceiptPolicy,
              maximumStepRows: 16,
              maximumStepBytes: 65536,
              maximumMappedIds: 1000,
              maximumJournalLogicalBytes: 516096
            },
            true,
            true,
            true
          )
        })
        if (chunks === 1)
          await store.withAuthenticatedPrivateStructuredDestination(async () => {
            const bytes = new Uint8Array([65]),
              sha256 = createHash('sha256').update(bytes).digest('hex')
            await withBrc38PrivateContentVersion(
              'binary',
              store,
              { expiresAt: store.operationExpiresAt, maximumBytes: 1, workingAllocation: working },
              { maximum: working.maximum, remaining: working.maximum },
              async version => {
                await version.begin({ bytes: 1, sha256 })
                await version.append(0, bytes)
                await version.finish()
              }
            )
          })
        await store.beginPrivateNativeComparison()
        await store.withAuthenticatedPrivateStructuredDestination(async () => {
          const capture = async () =>
            await store.withPrivateNativeDatabase(
              true,
              async db =>
                await db.transaction(async trx => {
                  store.assertPrivateNativeReadTransaction(trx)
                  const image = await readBrc38ComposedDatabaseImage(
                    trx,
                    {
                      maximumPhysicalBytes: store.limits.maximumPhysicalBytes,
                      maximumReadBytes: 16384,
                      expiresAt: store.operationExpiresAt,
                      workingAllocation: working
                    },
                    () => store.assertPrivateNativeReadTransaction(trx)
                  )
                  const progress = await trx('brc38_native_text_gc_progress').select('slot', 'nextFamily')
                  return { image, progress }
                })
            )
          const collect = async () =>
            await store.withPrivateNativeDatabase(
              false,
              async db =>
                await db.transaction(async trx => {
                  store.assertPrivateNativeWriteTransaction(trx)
                  const result = await collectBrc38NativePackedContent(trx, 1)
                  store.assertPrivateNativeWriteTransaction(trx)
                  return result
                })
            )
          const first = await capture()
          expect(first.progress).toEqual([{ slot: 1, nextFamily: 0 }])
          expect(await collect()).toEqual({ chunks, complete: true })
          const second = await capture()
          expect(second.progress).toEqual([{ slot: 1, nextFamily: 0 }])
          if (chunks === 0) expect(second).toEqual(first)
          else expect(second.image).not.toEqual(first.image)
          expect(await collect()).toEqual({ chunks: 0, complete: true })
          const third = await capture()
          expect(third).toEqual(second)
          expect(working.used).toBe(0)
          expect(store.limits).toEqual(selected.limits)
        })
        await store.requirePrivateNativeComparison()
      } finally {
        await fixture.close()
      }
    },
    120000
  )
})
