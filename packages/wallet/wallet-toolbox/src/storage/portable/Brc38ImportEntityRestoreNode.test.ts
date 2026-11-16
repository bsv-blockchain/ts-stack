import { randomUUID, createHash } from 'node:crypto'
import fc from 'fast-check'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { installBrc38ImportProvenanceSchema, readBrc38ImportOriginal } from './Brc38ImportProvenanceNode'
import { brc38ImportTableOrder } from './Brc38ImportPage'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateImportRestorePage,
  commitBrc38PrivateImportPage
} from './Brc38PrivateImportJournalNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { runInSeries } from '../../utility/runInSeries'
import { importBRC38, type BRC38WalletData } from './index'
import * as ids from './Brc38ImportIdMap'
import type { Knex } from 'knex'

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
describe('actual authenticated native restore and durable original provenance', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
    staged: Awaited<ReturnType<typeof previewPrivateFixture>>,
    admission: Brc38ImportJournalAdmission,
    proof: ReturnType<typeof restoreProofFixture>,
    original: BRC38WalletData,
    cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    const results = await Promise.allSettled(cleanup.map(close => close())),
      failed = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failed.length !== 0) throw new AggregateError(failed, 'Restore fixture retains physical cleanup')
  })
  async function open(
    transform?: (data: BRC38WalletData) => void,
    mode: 'restore' | 'merge' = 'restore',
    afterSchema?: (trx: Knex.Transaction) => Promise<void>
  ) {
    proof = restoreProofFixture()
    target = await previewDestinationFixture(async trx => {
      await installBrc38ImportTargetIndexes(trx)
      await installBrc38ImportJournalSchema(trx)
      await installBrc38ImportProvenanceSchema(trx)
      await afterSchema?.(trx)
    })
    cleanup.push(async () => await target.close())
    jest.spyOn(target.storage, 'getServices').mockReturnValue(proof.services)
    staged = await previewPrivateFixture(
      undefined,
      data => {
        restorePortableProof(data, proof)
        transform?.(data)
        original = JSON.parse(JSON.stringify(data)) as BRC38WalletData
      },
      2097152
    )
    cleanup.push(async () => await staged.close())
    const store = staged.value.reservation.store,
      preview = await previewBrc38PrivateImport(store, target.storage, mode, policy),
      metadata = await store.withAuthenticatedImportView(async (_json, value) => value),
      binding = store.binding
    if (binding === undefined) throw new Error('Actual private binding missing')
    admission = {
      scope: {
        importId: randomUUID(),
        bindingSha256: binding.digest,
        archiveSha256: binding.binding.archiveSha256,
        userId: 7
      },
      previewId: preview.previewId,
      originalLimitsJson: binding.limitsJson,
      expiresAt: preview.expiresAt,
      initialDestinationSha256: brc38ImportDestinationDigest(preview.target),
      totalRows: metadata.rows + 1,
      maximumStepRows: 1,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096
    }
    await prepareBrc38PrivateImportJournal(store, target.storage, {
      admission,
      receiptPolicy: policy
    })
  }
  async function commit(fromRow: number) {
    return await commitBrc38PrivateImportRestorePage(staged.value.reservation.store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow
    })
  }
  async function receipt() {
    return await target.k.transaction(async trx => await readBrc38ImportJournal(trx, admission))
  }
  test('all13 native tables preserve the legacy restore oracle except the explicitly preserved archive policy, and source primary remains unactivated', async () => {
    await open(data => {
      data.tables.outputBaskets[0].numberOfDesiredUTXOs = 144
      data.tables.outputBaskets[0].minimumDesiredUTXOValue = 32
    })
    const legacy = await previewDestinationFixture()
    cleanup.push(async () => await legacy.close())
    expect(await importBRC38(legacy.storage, original, { mode: 'restore' })).toMatchObject({
      inserts: 14,
      updates: 0,
      userId: 7
    })
    await commit(0)
    await runInSeries(brc38ImportTableOrder.entries(), async ([index, table]) => {
      const result = await commit(index + 1)
      expect(result.nextRow).toBe(index + 2)
      const expected = await legacy.k(nativeTables[index])
      if (table === 'outputBaskets') {
        expect(expected[0].minimumDesiredUTXOValue).toBe(5000)
        // The aggregate legacy helper retains its existing operational upgrade.
        // The new staged restore must instead preserve the archive's exact
        // policy, while every other native field retains the independent oracle.
        expected[0].minimumDesiredUTXOValue = original.tables.outputBaskets[0].minimumDesiredUTXOValue
      }
      expect(await target.k(nativeTables[index])).toEqual(expected)
      const durable = await target.k.transaction(
        async trx => await readBrc38ImportOriginal(trx, admission.scope, index + 1, 2097152)
      )
      expect(durable.tableName).toBe(table)
      expect(JSON.parse(durable.originalJson)).toEqual(original.tables[table][0])
    })
    const header = await target.k.transaction(
      async trx => await readBrc38ImportOriginal(trx, admission.scope, 0, 2097152)
    )
    expect(JSON.parse(header.originalJson).sourceStorage).toEqual(original.sourceStorage)
    expect(JSON.parse(header.originalJson).user).toEqual(original.user)
    expect((await target.k('users').first()).activeStorage).toBe('')
    expect((await legacy.k('users').first()).activeStorage).toBe('original-source')
    expect((await target.k('output_baskets').first()).minimumDesiredUTXOValue).toBe(32)
    expect((await receipt()).state).toBe('COMPLETE')
    expect(await target.k('brc38_import_original')).toHaveLength(14)
    expect((await target.k('brc38_import_original_budget').first()).rows).toBe(14)
    expect(await target.k('brc38_import_ids')).toHaveLength(9)
    expect(proof.isValidRootForHeight).toHaveBeenCalledTimes(1)
  })
  test('header and terminal-table lost acknowledgements replay without another native write, provenance charge or activation', async () => {
    await open()
    const first = await commit(0),
      charge = JSON.stringify(await target.k('brc38_import_original_budget'))
    expect(await commit(0)).toEqual(first)
    expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(charge)
    await runInSeries(brc38ImportTableOrder.entries(), async ([index]) => {
      await commit(index + 1)
    })
    const last = await receipt(),
      before = JSON.stringify(await target.k('brc38_import_original_budget')),
      sync = JSON.stringify(await target.k('sync_states'))
    expect(await commit(13)).toEqual(last)
    expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(before)
    expect(JSON.stringify(await target.k('sync_states'))).toBe(sync)
    expect(proof.isValidRootForHeight).toHaveBeenCalledTimes(1)
  })
  test('post-native mapping failure rolls back actual row, original record/counters, proof epoch and receiver cursor together', async () => {
    await open()
    await commit(0)
    const before = await receipt(),
      budget = JSON.stringify(await target.k('brc38_import_original_budget')),
      epoch = await target.storage.readPreparedBeefProofEpoch(),
      load = ids.loadBrc38ImportIdMap
    jest.spyOn(ids, 'loadBrc38ImportIdMap').mockImplementation(async (...args) => {
      const value = await load(...args)
      return {
        map: value.map,
        async persist() {
          await value.persist()
          throw new Error('synthetic restore post-map rollback')
        }
      }
    })
    await expect(commit(1)).rejects.toThrow('synthetic restore post-map rollback')
    expect(await target.k('proven_txs')).toHaveLength(0)
    expect(await target.k('brc38_import_ids')).toHaveLength(0)
    expect(await target.k('brc38_import_original')).toHaveLength(1)
    expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(budget)
    expect(await target.storage.readPreparedBeefProofEpoch()).toBe(epoch)
    expect(await receipt()).toEqual(before)
  })
  test('admitted merge cannot use the restore helper, while snapshotted ordinary page controls preserve legacy callbacks', async () => {
    await open(undefined, 'merge')
    await expect(commit(0)).rejects.toThrow('admitted restore mode')
    const options = {
      admission,
      receiptPolicy: policy,
      fromRow: 0,
      prepareEntityRestore: false,
      async apply(trx: Knex.Transaction) {
        await target.storage.insertUser(
          {
            userId: 7,
            identityKey: 'original-identity',
            activeStorage: '',
            created_at: new Date(0),
            updated_at: new Date(0)
          },
          trx
        )
      }
    }
    const pending = commitBrc38PrivateImportPage(staged.value.reservation.store, target.storage, options)
    options.prepareEntityRestore = true
    expect((await pending).nextRow).toBe(1)
    expect(await target.k('brc38_import_original')).toHaveLength(0)
  })
  test('late monitor occupancy refuses the first native header and durable provenance before any restore row', async () => {
    await open()
    await target.storage.insertMonitorEvent({
      id: 0,
      event: 'occupied',
      details: '',
      created_at: new Date(),
      updated_at: new Date()
    })
    await expect(commit(0)).rejects.toThrow('empty target')
    expect(await target.k('users')).toHaveLength(0)
    expect(await target.k('brc38_import_original')).toHaveLength(0)
    expect(await target.k('brc38_import_original_budget')).toHaveLength(0)
    expect((await receipt()).nextRow).toBe(0)
  })
  test('invalid configured-chain proof is refused during preparation before its original/native write or cursor', async () => {
    await open()
    await commit(0)
    proof.isValidRootForHeight.mockResolvedValue(false)
    const before = await receipt()
    await expect(commit(1)).rejects.toThrow()
    expect(await target.k('proven_txs')).toHaveLength(0)
    expect(await target.k('brc38_import_original')).toHaveLength(1)
    expect(await receipt()).toEqual(before)
  })
  test('a mismatched admitted native profile is refused before creating its user or original provenance', async () => {
    await open(data => {
      data.user.userId = 8
      for (const rows of Object.values(data.tables))
        for (const row of rows) if (Object.hasOwn(row, 'userId')) row.userId = 8
    })
    await expect(commit(0)).rejects.toThrow('admitted profile')
    expect(await target.k('users')).toHaveLength(0)
    expect(await target.k('brc38_import_original')).toHaveLength(0)
    expect(await target.k('brc38_import_original_budget')).toHaveLength(0)
    expect((await receipt()).nextRow).toBe(0)
  })
  test('cancellation after the actual native header insert rolls back its user, originals and cursor', async () => {
    await open()
    const controller = new AbortController(),
      insert = target.storage.insertUser.bind(target.storage)
    jest.spyOn(target.storage, 'insertUser').mockImplementation(async (...args) => {
      const result = await insert(...args)
      controller.abort(new Error('cancel after native restore header'))
      return result
    })
    await expect(
      commitBrc38PrivateImportRestorePage(staged.value.reservation.store, target.storage, {
        admission,
        receiptPolicy: policy,
        fromRow: 0,
        signal: controller.signal
      })
    ).rejects.toThrow('cancel after native restore header')
    expect(await target.k('users')).toHaveLength(0)
    expect(await target.k('brc38_import_original')).toHaveLength(0)
    expect(await target.k('brc38_import_original_budget')).toHaveLength(0)
    expect((await receipt()).nextRow).toBe(0)
  })
  test('reusing an already applied prepared native operation rolls back the entire header transaction', async () => {
    await open()
    await expect(
      commitBrc38PrivateImportPage(staged.value.reservation.store, target.storage, {
        admission,
        receiptPolicy: policy,
        fromRow: 0,
        prepareEntityRestore: true,
        async apply(trx, _data, _references, _history, _targets, _existing, _merge, restore) {
          if (restore === undefined) throw new Error('Prepared restore missing')
          await restore.apply(trx)
          await restore.apply(trx)
        }
      })
    ).rejects.toThrow('already consumed')
    expect(await target.k('users')).toHaveLength(0)
    expect(await target.k('brc38_import_original')).toHaveLength(0)
    expect(await target.k('brc38_import_original_budget')).toHaveLength(0)
    expect((await receipt()).nextRow).toBe(0)
  })
  test('missing owned provenance trigger is refused under the fresh generation before any header write', async () => {
    await open(undefined, 'restore', async trx => {
      await trx.raw('DROP TRIGGER brc38_import_original_insert_guard')
    })
    await expect(commit(0)).rejects.toThrow('provenance differs')
    expect(await target.k('users')).toHaveLength(0)
    expect((await receipt()).nextRow).toBe(0)
  })
  test('actual SQL rejects original scope/prefix/quota violations and immutable limit or payload rewrites', async () => {
    await open()
    await commit(0)
    const originalJson = '{}',
      record = {
        ...admission.scope,
        sourceRow: 1,
        tableName: 'provenTxs',
        originalJson,
        sha256: createHash('sha256').update(originalJson).digest('hex'),
        logicalBytes: 514
      }
    await expect(target.k('brc38_import_original').insert({ ...record, userId: 8 })).rejects.toThrow(
      'scope, prefix or quota'
    )
    await expect(target.k('brc38_import_original').insert({ ...record, sourceRow: 2 })).rejects.toThrow(
      'scope, prefix or quota'
    )
    const big = '"' + 'x'.repeat(JSON.parse(admission.originalLimitsJson)[1]) + '"'
    await expect(
      target.k('brc38_import_original').insert({
        ...record,
        originalJson: big,
        sha256: createHash('sha256').update(big).digest('hex'),
        logicalBytes: 512 + Buffer.byteLength(big)
      })
    ).rejects.toThrow('scope, prefix or quota')
    await expect(target.k('brc38_import_original_budget').update({ maximumRows: 1000000 })).rejects.toThrow('immutable')
    await expect(target.k('brc38_import_original').update({ originalJson: '{}' })).rejects.toThrow('immutable')
    await expect(target.k('brc38_import_original').delete()).rejects.toThrow('owned cleanup')
    expect(await target.k('brc38_import_original')).toHaveLength(1)
  })
  test('bounded original read refuses a wrong profile and undersized byte allowance before loading payload text', async () => {
    await open()
    await commit(0)
    await expect(
      target.k.transaction(
        async trx => await readBrc38ImportOriginal(trx, { ...admission.scope, userId: 8 }, 0, 2097152)
      )
    ).rejects.toThrow('provenance differs')
    const selects: string[] = []
    target.k.on('query', (query: { sql: string }) => selects.push(query.sql))
    await expect(
      target.k.transaction(async trx => await readBrc38ImportOriginal(trx, admission.scope, 0, 1))
    ).rejects.toThrow('provenance differs')
    expect(selects.some(sql => sql.includes('select `tableName`, `originalJson`'))).toBe(false)
  })
  test('full300 actual source pages preserve native values and atomic original/map/cursor rollback without renewing ownership', async () => {
    await open(data => {
      for (let index = 0; index < 300; index++)
        data.tables.outputBaskets.push({
          ...data.tables.outputBaskets[0],
          basketId: 1000 + index,
          name: 'property-' + index
        })
    })
    await commit(0)
    await commit(1)
    await commit(2)
    const fixed = JSON.stringify(admission),
      load = ids.loadBrc38ImportIdMap
    let rollback = false,
      index = 0
    jest.spyOn(ids, 'loadBrc38ImportIdMap').mockImplementation(async (...args) => {
      const value = await load(...args)
      return {
        map: value.map,
        async persist() {
          await value.persist()
          if (rollback) throw new Error('synthetic native restore property rollback')
        }
      }
    })
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async fail => {
        const fromRow = index + 3,
          before = await receipt(),
          budget = JSON.stringify(await target.k('brc38_import_original_budget'))
        if (fail) {
          rollback = true
          try {
            await expect(commit(fromRow)).rejects.toThrow('synthetic native restore property rollback')
          } finally {
            rollback = false
          }
          expect(await target.k('output_baskets').where({ basketId: 1000 + index })).toHaveLength(0)
          expect(await receipt()).toEqual(before)
          expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(budget)
        }
        expect((await commit(fromRow)).nextRow).toBe(fromRow + 1)
        expect(
          (
            await target
              .k('output_baskets')
              .where({ basketId: 1000 + index })
              .first()
          ).name
        ).toBe('property-' + index)
        expect(
          JSON.parse(
            (
              await target.k.transaction(
                async trx => await readBrc38ImportOriginal(trx, admission.scope, fromRow, 2097152)
              )
            ).originalJson
          ).basketId
        ).toBe(1000 + index)
        expect(JSON.stringify(admission)).toBe(fixed)
        index++
      }),
      {
        numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
        seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true
      }
    )
    expect(index).toBe(300)
  }, 180000)
})
