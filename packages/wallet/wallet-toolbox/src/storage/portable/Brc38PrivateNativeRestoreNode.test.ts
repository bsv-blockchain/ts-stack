import { WalletStorageManager } from '../WalletStorageManager'
import { previewDestinationFixture, previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { brc38ImportTableOrder } from './Brc38ImportPage'
import { readBrc38ImportOriginal } from './Brc38ImportProvenanceNode'
import { runInSeries } from '../../utility/runInSeries'
import fc from 'fast-check'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { importBRC38, type BRC38WalletData } from './index'
import { registerBrc38PrivateDestinationLease } from './Brc38PrivateDestinationLeaseNode'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

const nativeTables = [
  'proven_txs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'transactions',
  'outputs',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'commissions',
  'proven_tx_reqs',
  'sync_states'
]
describe('actual native RESTORE inside the admitted private destination', () => {
  let cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close())),
      errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Private native restore retains physical cleanup')
  })
  async function open() {
    const proof = restoreProofFixture()
    let original!: BRC38WalletData
    const staged = await previewPrivateFixture(
      undefined,
      data => {
        restorePortableProof(data, proof)
        original = JSON.parse(JSON.stringify(data)) as BRC38WalletData
      },
      2097152,
      // The complete native journal schema exceeds the 4 MiB fixture's usable
      // main-file pages after its unchanged three-image recovery reservation.
      8388608
    )
    cleanup.push(async () => await staged.close())
    const options = {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 1,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services
    }
    const destination = await Brc38PrivateNativeRestoreNode.open(staged.value.reservation.store, options)
    return { staged, destination, original, options, proof }
  }
  test('structured v5 refuses a genuine legacy stage before installing a native destination', async () => {
    const staged = await previewPrivateFixture(),
      store = staged.value.reservation.store,
      proof = restoreProofFixture(),
      before = await store.knex('metadata').first(),
      parent = staged.directory,
      expiresAt = staged.selected.limits.expiresAt,
      options = {
        receiptPolicy: previewReceiptPolicy,
        maximumStepRows: 1,
        maximumStepBytes: 65536,
        maximumMappedIds: 1000,
        maximumJournalLogicalBytes: 516096,
        services: proof.services,
        structuredResources: {
          sourcePolicy: {
            privateIndexParent: parent,
            maximumTemporaryIndexBytes: 1048576,
            maximumIndexMembers: 100,
            maximumStructuredBytes: 1000,
            maximumCanonicalBytes: 1000
          },
          projectionPolicy: {
            privateParent: parent,
            maximumTemporaryFileBytes: 2097152,
            maximumMembers: 100,
            maximumOutputBytes: 1000,
            maximumScalarBytes: 1000,
            expiresAt
          },
          maximumCombinedTemporaryBytes: 3145728
        }
      }
    cleanup.push(async () => await staged.close())
    await expect(Brc38PrivateNativeRestoreNode.openStructured(store, options)).rejects.toThrow()
    expect(await store.knex.schema.hasTable('private_native_restore')).toBe(false)
    expect(await store.knex.schema.hasTable('users')).toBe(false)
    expect(await store.knex('metadata').first()).toEqual(before)
  })
  test('all13 native tables and original history remain in the private file while the active manager continues serving both profiles', async () => {
    const active = await previewDestinationFixture()
    cleanup.push(async () => await active.close())
    const legacy = await previewDestinationFixture()
    cleanup.push(async () => await legacy.close())
    await active.storage.insertUser({
      userId: 7,
      identityKey: 'original-identity',
      activeStorage: 'synthetic target',
      created_at: new Date(0),
      updated_at: new Date(0)
    })
    await active.storage.insertUser({
      userId: 8,
      identityKey: 'another-profile',
      activeStorage: 'synthetic target',
      created_at: new Date(0),
      updated_at: new Date(0)
    })
    const manager = new WalletStorageManager('original-identity', active.storage)
    await manager.makeAvailable()
    const { staged, destination, original } = await open(),
      privateDb = staged.value.reservation.store.knex,
      expectedUsers = await active.k('users')
    expect(manager.getActive()).toBe(active.storage)
    expect(manager.isActiveEnabled).toBe(true)
    expect(Reflect.get(destination, 'storage')).toBeUndefined()
    expect(Reflect.get(destination, 'makeAvailable')).toBeUndefined()
    expect(Reflect.get(destination, 'setActive')).toBeUndefined()
    expect(privateDb).not.toBe(active.k)
    await importBRC38(legacy.storage, original, { mode: 'restore' })
    await destination.step(0)
    await runInSeries(brc38ImportTableOrder.entries(), async ([index, table]) => {
      // Independent foreground work changes the real configured primary between
      // background steps. Neither profile is registered on the private facade.
      await active.storage.insertTxLabel({
        txLabelId: 0,
        userId: index % 2 === 0 ? 7 : 8,
        label: 'foreground-' + index,
        isDeleted: false,
        created_at: new Date(0),
        updated_at: new Date(0)
      })
      const result = await destination.step(index + 1)
      expect(result.nextRow).toBe(index + 2)
      expect(await privateDb(nativeTables[index])).toEqual(await legacy.k(nativeTables[index]))
      const provenance = await privateDb.transaction(
        async trx => await readBrc38ImportOriginal(trx, destination.admission.scope, index + 1, 2097152)
      )
      expect(JSON.parse(provenance.originalJson)).toEqual(original.tables[table][0])
      expect(await active.k('users')).toEqual(expectedUsers)
      expect(await manager.getAuth(true)).toMatchObject({
        identityKey: 'original-identity',
        userId: 7,
        isActive: true
      })
      expect(await active.storage.findTxLabels({ partial: { userId: 7 } })).toHaveLength(Math.floor(index / 2) + 1)
      await runInSeries(
        nativeTables.filter(name => name !== 'tx_labels'),
        async name => {
          expect(await active.k(name)).toEqual([])
        }
      )
    })
    expect(await destination.status()).toMatchObject({ state: 'COMPLETE', nextRow: 14 })
    expect((await privateDb('users').first()).activeStorage).toBe('')
    expect(await staged.root.usage()).toMatchObject({
      imports: 1,
      logicalBytes: staged.selected.limits.maximumLogicalBytes
    })
    expect((await privateDb.raw('PRAGMA max_page_count'))[0].max_page_count).toBe(
      Math.floor((staged.selected.limits.maximumPhysicalBytes - 65536) / (3 * 4096))
    )
  })
  test('physical handoff reopens the same admission and acknowledged prefix without making it a provider', async () => {
    const { staged, destination, options } = await open()
    await destination.step(0)
    const first = await destination.step(1),
      originalAdmission = destination.admission
    await destination.close()
    await expect(destination.status()).rejects.toThrow()
    const resumed = await staged.root.resume(
      staged.value.reservation.id,
      staged.selected.limits,
      staged.selected.binding
    )
    staged.held.push(resumed)
    const next = await Brc38PrivateNativeRestoreNode.open(resumed.store, options)
    expect(next.admission).toEqual(originalAdmission)
    expect(await next.status()).toEqual(first)
    expect(await next.step(1)).toEqual(first)
    expect(await next.step(2)).toMatchObject({ nextRow: 3 })
    expect(next.admission.expiresAt).toBe(staged.selected.limits.expiresAt)
    await expect(Brc38PrivateNativeRestoreNode.open(resumed.store, { ...options, maximumStepRows: 2 })).rejects.toThrow(
      'policy'
    )
    expect((await resumed.store.knex('users').first()).activeStorage).toBe('')
  })
  test('an ordinary active storage cannot acquire the private DELETE-journal authority', async () => {
    const active = await previewDestinationFixture()
    cleanup.push(async () => await active.close())
    const { staged } = await open()
    expect(() => registerBrc38PrivateDestinationLease(active.storage, staged.value.reservation.store)).toThrow(
      'actual claimed private stage'
    )
    expect((await active.k.raw('PRAGMA journal_mode'))[0].journal_mode).toBe('wal')
  })
  test('cancellation during actual chain preparation preserves the prefix and disposal removes native rows and original charges', async () => {
    const { staged, destination, proof } = await open(),
      store = staged.value.reservation.store,
      controller = new AbortController(),
      cause = new Error('synthetic private restore cancellation')
    const header = await destination.step(0),
      originalRows = await store.knex('brc38_import_original'),
      usage = await staged.root.usage()
    proof.isValidRootForHeight.mockImplementationOnce(async () => {
      controller.abort(cause)
      return true
    })
    await expect(destination.step(1, controller.signal)).rejects.toThrow(cause.message)
    expect(await destination.status()).toEqual(header)
    expect(await store.knex('proven_txs')).toEqual([])
    expect(await store.knex('brc38_import_original')).toEqual(originalRows)
    expect(await staged.root.usage()).toEqual(usage)
    await expect(destination.step(1)).resolves.toMatchObject({ nextRow: 2 })
    await expect(destination.discard(staged.root, randomUUID(), cause)).rejects.toThrow('reservation is absent')
    expect(await staged.root.usage()).toEqual(usage)
    await destination.discard(staged.root, staged.value.reservation.id, cause)
    await expect(lstat(join(staged.directory, staged.value.reservation.id))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await staged.root.usage()).toEqual({
      imports: 0,
      logicalBytes: 0,
      physicalBytes: 3145728
    })
    await expect(destination.status()).rejects.toThrow()
  })
  test('expiry refuses work and keeps the live-owner charge until explicit physical disposal', async () => {
    const { staged, destination, options } = await open(),
      before = await staged.root.usage(),
      clock = jest.spyOn(Date, 'now').mockReturnValue(staged.selected.limits.expiresAt)
    try {
      await expect(destination.step(0)).rejects.toThrow()
      await expect(destination.status()).rejects.toThrow()
      await expect(Brc38PrivateNativeRestoreNode.open(staged.value.reservation.store, options)).rejects.toThrow()
      expect(await staged.root.collectExpired(1)).toBe(0)
      expect(await staged.root.usage()).toEqual(before)
      await destination.discard(staged.root, staged.value.reservation.id, new Error('expired private restore'))
      expect(await staged.root.usage()).toEqual({
        imports: 0,
        logicalBytes: 0,
        physicalBytes: 3145728
      })
    } finally {
      clock.mockRestore()
    }
  })
  test('300 generated replay and cancellation schedules preserve complete native data, originals and fixed admission', async () => {
    const { staged, destination, proof } = await open(),
      db = staged.value.reservation.store.knex,
      active = new Set<Promise<void>>()
    await runInSeries(
      Array.from({ length: 14 }, (_, index) => index),
      async index => {
        await destination.step(index)
      }
    )
    const complete = await destination.status(),
      admission = destination.admission,
      tables = [
        ...nativeTables,
        'users',
        'brc38_import_original',
        'brc38_import_original_budget',
        'brc38_import_journal',
        'brc38_import_ids'
      ],
      snapshot = await Promise.all(tables.map(async table => await db(table))),
      usage = await staged.root.usage(),
      proofCalls = proof.isValidRootForHeight.mock.calls.length
    let failed = false,
      firstCause: unknown
    expect(complete).toMatchObject({ state: 'COMPLETE', nextRow: 14 })
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ fromRow: fc.integer({ min: -1, max: 15 }), cancelled: fc.boolean() }), {
            minLength: 1,
            maxLength: 3
          }),
          schedules => {
            const work = runInSeries(schedules, async schedule => {
              const controller = new AbortController()
              if (schedule.cancelled) controller.abort(new Error('generated private cancellation'))
              if (!schedule.cancelled && schedule.fromRow === 13)
                expect(await destination.step(schedule.fromRow, controller.signal)).toEqual(complete)
              else await expect(destination.step(schedule.fromRow, controller.signal)).rejects.toThrow()
              expect(await destination.status()).toEqual(complete)
            })
            active.add(work)
            void work.then(
              () => active.delete(work),
              () => active.delete(work)
            )
            return work
          }
        ),
        {
          numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? 300)),
          seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026),
          path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
          interruptAfterTimeLimit: 150000,
          markInterruptAsFailure: true
        }
      )
    } catch (cause) {
      failed = true
      firstCause = cause
    }
    const drained = await Promise.allSettled(active),
      errors = drained.flatMap(value => (value.status === 'rejected' ? [value.reason] : []))
    if (errors.length)
      throw new AggregateError(
        [...(failed ? [firstCause] : []), ...errors],
        'Generated native restore retains physical work'
      )
    if (failed) throw firstCause
    expect(await Promise.all(tables.map(async table => await db(table)))).toEqual(snapshot)
    expect(await staged.root.usage()).toEqual(usage)
    expect(destination.admission).toEqual(admission)
    expect(proof.isValidRootForHeight).toHaveBeenCalledTimes(proofCalls)
    expect((await db('users').first()).activeStorage).toBe('')
  }, 180000)
})
