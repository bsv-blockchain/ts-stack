import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import {
  installBrc38ImportProvenanceSchema,
  prepareBrc38ImportOriginals,
  readBrc38ImportOriginal
} from './Brc38ImportProvenanceNode'
import { brc38ImportTableOrder, prepareBrc38ImportPage } from './Brc38ImportPage'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateImportMergePage,
  commitBrc38PrivateImportPage
} from './Brc38PrivateImportJournalNode'
import { withBrc38KnexImportReadDestination } from './Brc38KnexDestinationFence'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { runInSeries } from '../../utility/runInSeries'
import { importBRC38, type BRC38WalletData } from './index'
import * as ids from './Brc38ImportIdMap'
import * as utilityHelpers from '../../utility/utilityHelpers'
import { EntitySyncState } from '../schema/entities/EntitySyncState'

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
describe('actual native merge and independently durable original provenance', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
    staged: Awaited<ReturnType<typeof previewPrivateFixture>>,
    admission: Brc38ImportJournalAdmission,
    preview: Awaited<ReturnType<typeof previewBrc38PrivateImport>>,
    proof: ReturnType<typeof restoreProofFixture>,
    original: BRC38WalletData,
    cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    const results = await Promise.allSettled(cleanup.map(close => close())),
      errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length !== 0) throw new AggregateError(errors, 'Merge provenance fixture retains physical cleanup')
  })
  async function localUser(storage: typeof target.storage) {
    await storage.insertUser({
      userId: 7,
      identityKey: 'original-identity',
      activeStorage: 'local-primary',
      created_at: new Date(0),
      updated_at: new Date(0)
    })
  }
  async function open(
    transform?: (data: BRC38WalletData) => void,
    maximumStepBytes = 2097152,
    maximumStepRows = 128,
    nativeSetup?: (storage: typeof target.storage) => Promise<void>
  ) {
    proof = restoreProofFixture()
    target = await previewDestinationFixture(async trx => {
      await installBrc38ImportTargetIndexes(trx)
      await installBrc38ImportJournalSchema(trx)
      await installBrc38ImportProvenanceSchema(trx)
    })
    cleanup.push(async () => await target.close())
    jest.spyOn(target.storage, 'getServices').mockReturnValue(proof.services)
    await localUser(target.storage)
    await nativeSetup?.(target.storage)
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
    const store = staged.value.reservation.store
    preview = await previewBrc38PrivateImport(store, target.storage, 'merge', policy)
    const binding = store.binding,
      metadata = await store.withAuthenticatedImportView(async (_json, value) => value)
    if (binding === undefined) throw new Error('Actual private source binding missing')
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
      maximumStepRows,
      maximumStepBytes,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096
    }
    await prepareBrc38PrivateImportJournal(store, target.storage, {
      admission,
      receiptPolicy: policy
    })
  }
  async function commit(fromRow: number, signal?: AbortSignal) {
    return await commitBrc38PrivateImportMergePage(staged.value.reservation.store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow,
      signal
    })
  }
  async function receipt() {
    return await target.k.transaction(async trx => await readBrc38ImportJournal(trx, admission))
  }
  async function originalRow(sourceRow: number) {
    return await target.k.transaction(
      async trx => await readBrc38ImportOriginal(trx, admission.scope, sourceRow, 2097152)
    )
  }
  test('all13 actual native tables match legacy merge while raw incoming IDs/profile/history and existing local primary remain distinct', async () => {
    await open(data => {
      data.user.userId = 8
      for (const table of brc38ImportTableOrder)
        for (const row of data.tables[table]) if (Object.hasOwn(row, 'userId')) row.userId = 8
    })
    const beforeUser = await target.k('users'),
      legacy = await previewDestinationFixture()
    cleanup.push(async () => await legacy.close())
    await localUser(legacy.storage)
    jest.spyOn(legacy.storage, 'getServices').mockReturnValue(proof.services)
    expect(await importBRC38(legacy.storage, original, { mode: 'merge' })).toMatchObject({
      mode: 'merge',
      userId: 7
    })
    await commit(0)
    expect(JSON.parse((await originalRow(0)).originalJson).user).toEqual(original.user)
    expect(JSON.parse((await originalRow(0)).originalJson).sourceStorage).toEqual(original.sourceStorage)
    await runInSeries(brc38ImportTableOrder.entries(), async ([index, table]) => {
      await commit(index + 1)
      expect(await target.k(nativeTables[index])).toEqual(await legacy.k(nativeTables[index]))
      const value = await originalRow(index + 1)
      expect(value.tableName).toBe(table)
      expect(JSON.parse(value.originalJson)).toEqual(original.tables[table][0])
    })
    expect(await target.k('users')).toEqual(await legacy.k('users'))
    expect((await target.k('users').first()).activeStorage).toBe(beforeUser[0].activeStorage)
    expect((await receipt()).state).toBe('COMPLETE')
    expect(await target.k('brc38_import_original')).toHaveLength(14)
    expect((await target.k('brc38_import_original_budget').first()).rows).toBe(14)
    expect((await target.k('transactions').first()).transactionId).not.toBe(
      original.tables.transactions[0].transactionId
    )
    expect(JSON.parse((await originalRow(12)).originalJson).notify).toEqual(original.tables.provenTxReqs[0].notify)
  })
  test('empty archive completes the native source checkpoint while retaining only its original header', async () => {
    await open(data => {
      for (const table of brc38ImportTableOrder) data.tables[table] = []
    })
    const start = Date.now(),
      legacy = await previewDestinationFixture()
    cleanup.push(async () => await legacy.close())
    await localUser(legacy.storage)
    const randomReference = jest.spyOn(utilityHelpers, 'randomBytesBase64').mockReturnValue('AAECAwQFBgcICQoL')
    await importBRC38(legacy.storage, original, { mode: 'merge' })
    expect((await commit(0)).state).toBe('COMPLETE')
    const actual = await target.k('sync_states').first(),
      expected = await legacy.k('sync_states').first()
    const { created_at: ac, updated_at: au, ...actualFields } = actual,
      { created_at: ec, updated_at: eu, ...expectedFields } = expected
    expect(actualFields).toEqual(expectedFields)
    expect(actual.refNum).toBe('AAECAwQFBgcICQoL')
    expect(randomReference).toHaveBeenCalledWith(12)
    for (const value of [ac, au, ec, eu]) {
      const time = target.storage.validateDate(value).getTime()
      expect(time).toBeGreaterThanOrEqual(start)
      expect(time).toBeLessThanOrEqual(Date.now())
    }
    expect(await target.k('brc38_import_original')).toHaveLength(1)
  })
  test.each([false, true])(
    'later sync-history pages match legacy merge with the own source last=%s',
    async ownSourceLast => {
      await open(
        data => {
          const source = data.tables.syncStates[0]
          source.when = '2000-01-01T00:00:00.000Z'
          source.syncStateId = ownSourceLast ? 200 : 90
          const other = {
            ...source,
            syncStateId: 100,
            refNum: 'other-sync-ref',
            storageIdentityKey: 'other-peer',
            storageName: 'other peer',
            syncMap: {
              output: {
                entityName: 'original-output',
                count: -9,
                idMap: { '160': 16, '161': 999, '01': 1e300, '1': 16 }
              },
              transaction: { entityName: 'transaction', count: 0, idMap: { '17': 14, '18': 999 } },
              txLabelMap: { entityName: 'txLabelMap', count: 0, idMap: { '0': 200 } }
            }
          }
          data.tables.syncStates = ownSourceLast ? [other, source] : [source, other]
        },
        2097152,
        1
      )
      const legacy = await previewDestinationFixture()
      cleanup.push(async () => await legacy.close())
      await localUser(legacy.storage)
      jest.spyOn(legacy.storage, 'getServices').mockReturnValue(proof.services)
      await importBRC38(legacy.storage, original, { mode: 'merge' })
      let next = await commit(0)
      await runInSeries(Array.from({ length: 20 }), async () => {
        if (next.state !== 'COMPLETE') next = await commit(next.nextRow)
      })
      expect(next.state).toBe('COMPLETE')
      const source = await target
        .k('sync_states')
        .where({ storageIdentityKey: original.sourceStorage.storageIdentityKey })
        .first()
      expect(target.storage.validateDate(source.when).toISOString()).toBe('2000-01-01T00:00:00.000Z')
      expect(await target.k('sync_states').orderBy('syncStateId')).toEqual(
        await legacy.k('sync_states').orderBy('syncStateId')
      )
      expect(await target.k('sync_states')).toHaveLength(2)
      expect(await target.k('brc38_import_original')).toHaveLength(15)
    }
  )
  async function existingSource(storage: typeof target.storage, names: readonly string[]) {
    await runInSeries(names.entries(), async ([index, storageName]) => {
      const state = new EntitySyncState()
      Object.assign(state.api, {
        created_at: new Date(0),
        updated_at: new Date(0),
        when: new Date(0),
        userId: 7,
        storageIdentityKey: 'original-source',
        storageName,
        refNum: 'prior-' + index
      })
      await storage.insertSyncState(state.toApi())
    })
  }
  test('renamed provider retains the exact legacy native source', async () => {
    const count = 1
    const names = count === 1 ? ['old source name'] : ['old source name', 'original source', 'another old name'],
      setup = async (storage: typeof target.storage) => await existingSource(storage, names)
    await open(undefined, 2097152, 128, setup)
    const legacy = await previewDestinationFixture()
    cleanup.push(async () => await legacy.close())
    await localUser(legacy.storage)
    await setup(legacy.storage)
    jest.spyOn(legacy.storage, 'getServices').mockReturnValue(proof.services)
    await importBRC38(legacy.storage, original, { mode: 'merge' })
    let next = await commit(0)
    await runInSeries(Array.from({ length: 20 }), async () => {
      if (next.state !== 'COMPLETE') next = await commit(next.nextRow)
    })
    expect(next.state).toBe('COMPLETE')
    await runInSeries(nativeTables, async table => {
      expect(await target.k(table)).toEqual(await legacy.k(table))
    })
    expect(await target.k('users')).toEqual(await legacy.k('users'))
    expect(await target.k('sync_states')).toHaveLength(count)
    expect(await target.k('brc38_import_original')).toHaveLength(14)
  })
  test.each([
    {
      names: ['old source name', 'another old name'],
      message: 'Storage identity has conflicting sync states. Use a unique identity for each storage provider.'
    },
    {
      names: ['old source name', 'original source', 'another old name'],
      message: 'Result must exist and be unique.'
    }
  ])('historical provider conflicts refuse with the actual legacy error: $message', async ({ names, message }) => {
    await open(undefined, 2097152, 128, async storage => await existingSource(storage, names))
    const before = await receipt(),
      rows = await target.k('sync_states'),
      users = await target.k('users'),
      legacy = await previewDestinationFixture()
    cleanup.push(async () => await legacy.close())
    await localUser(legacy.storage)
    await existingSource(legacy.storage, names)
    await expect(importBRC38(legacy.storage, original, { mode: 'merge' })).rejects.toThrow(message)
    await expect(commit(0)).rejects.toThrow(message)
    expect(await target.k('sync_states')).toEqual(rows)
    expect(await target.k('users')).toEqual(users)
    expect(await target.k('brc38_import_original')).toHaveLength(0)
    expect(await target.k('brc38_import_original_budget')).toHaveLength(0)
    expect(await receipt()).toEqual(before)
  })
  test('header and table lost acknowledgements replay without another original charge, native write or chain validation', async () => {
    await open()
    const header = await commit(0),
      headerCharge = JSON.stringify(await target.k('brc38_import_original_budget'))
    expect(await commit(0)).toEqual(header)
    expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(headerCharge)
    const insert = jest.spyOn(target.storage, 'insertProvenTx'),
      first = await commit(1),
      charge = JSON.stringify(await target.k('brc38_import_original_budget')),
      epoch = await target.storage.readPreparedBeefProofEpoch()
    expect(await commit(1)).toEqual(first)
    expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(charge)
    expect(await target.k('brc38_import_original')).toHaveLength(2)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(proof.isValidRootForHeight).toHaveBeenCalledTimes(1)
    expect(await target.storage.readPreparedBeefProofEpoch()).toBe(epoch)
  })
  test('natural-key alias prefixes retain both raw records but merge one native transaction without duplicate original charges', async () => {
    await open(data => {
      data.tables.transactions.push({
        ...data.tables.transactions[0],
        transactionId: 114,
        reference: 'archive-second'
      })
      data.tables.provenTxReqs[0].notify = { transactionIds: [14, 114] }
    })
    let next = await commit(0)
    await runInSeries(Array.from({ length: 20 }), async () => {
      if (next.state !== 'COMPLETE') next = await commit(next.nextRow)
    })
    expect(next).toMatchObject({ state: 'COMPLETE', nextRow: 15 })
    expect(await target.k('transactions')).toHaveLength(1)
    expect(await target.k('brc38_import_original')).toHaveLength(15)
    expect((await target.k('brc38_import_original_budget').first()).rows).toBe(15)
    expect(JSON.parse((await originalRow(5)).originalJson).transactionId).toBe(14)
    expect(JSON.parse((await originalRow(6)).originalJson).transactionId).toBe(114)
    const mappings = await target.k('brc38_import_ids').where({ entity: 'transaction' })
    expect(mappings).toHaveLength(2)
    expect(new Set(mappings.map(row => row.localId)).size).toBe(1)
  })
  test('post-map failure rolls native row, durable originals/counters, cache epoch, maps and cursor back together', async () => {
    await open()
    await commit(0)
    const before = await receipt(),
      charge = JSON.stringify(await target.k('brc38_import_original_budget')),
      epoch = await target.storage.readPreparedBeefProofEpoch(),
      load = ids.loadBrc38ImportIdMap
    jest.spyOn(ids, 'loadBrc38ImportIdMap').mockImplementation(async (...args) => {
      const value = await load(...args)
      return {
        map: value.map,
        async persist() {
          await value.persist()
          throw new Error('synthetic merge provenance post-map rollback')
        }
      }
    })
    await expect(commit(1)).rejects.toThrow('synthetic merge provenance post-map rollback')
    expect(await target.k('proven_txs')).toHaveLength(0)
    expect(await target.k('brc38_import_ids')).toHaveLength(0)
    expect(await target.k('brc38_import_original')).toHaveLength(1)
    expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(charge)
    expect(await target.storage.readPreparedBeefProofEpoch()).toBe(epoch)
    expect(await receipt()).toEqual(before)
  })
  test('cancellation after actual native insertion rolls original records and the entire page back', async () => {
    await open()
    await commit(0)
    const controller = new AbortController(),
      before = await receipt(),
      charge = JSON.stringify(await target.k('brc38_import_original_budget')),
      insert = target.storage.insertProvenTx.bind(target.storage)
    jest.spyOn(target.storage, 'insertProvenTx').mockImplementation(async (...args) => {
      const result = await insert(...args)
      controller.abort(new Error('cancel after native merge insert'))
      return result
    })
    await expect(commit(1, controller.signal)).rejects.toThrow('cancel after native merge insert')
    expect(await target.k('proven_txs')).toHaveLength(0)
    expect(await target.k('brc38_import_ids')).toHaveLength(0)
    expect(await target.k('brc38_import_original')).toHaveLength(1)
    expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(charge)
    expect(await receipt()).toEqual(before)
  })
  test('original and native preparations each fit alone but their combined fixed allowance refuses before any write', async () => {
    await open(data => {
      data.tables.transactions[0].description = 'd'.repeat(50000)
    }, 1048576)
    await runInSeries([0, 1, 2, 3, 4], async index => {
      await commit(index)
    })
    const store = staged.value.reservation.store,
      before = await receipt(),
      charge = JSON.stringify(await target.k('brc38_import_original_budget')),
      budget = { maximum: admission.maximumStepBytes, remaining: admission.maximumStepBytes }
    await store.withAuthenticatedImportRead(async (_json, metadata, reader) => {
      const page = await prepareBrc38ImportPage(reader, metadata, admission, 5)
      await page.consume(
        async data =>
          await withBrc38KnexImportReadDestination(target.storage, preview.target, policy, async trx => {
            await prepareBrc38ImportOriginals(trx, reader, admission, data, 5, budget)
          })
      )
    })
    expect(budget.remaining).toBeGreaterThan(0)
    await expect(
      commitBrc38PrivateImportPage(store, target.storage, {
        admission,
        receiptPolicy: policy,
        fromRow: 5,
        prepareEntityMerge: true,
        apply: async () => {
          throw new Error('native preparation fits independently')
        }
      })
    ).rejects.toThrow('native preparation fits independently')
    await expect(commit(5)).rejects.toBeInstanceOf(SnapshotResourceLimitError)
    expect(await target.k('transactions')).toHaveLength(0)
    expect(JSON.stringify(await target.k('brc38_import_original_budget'))).toBe(charge)
    expect(await receipt()).toEqual(before)
  })
  test('unmatched original-preparation mode refuses while ordinary callback defaults remain snapshotted and unchanged', async () => {
    await open()
    const store = staged.value.reservation.store
    await expect(
      commitBrc38PrivateImportPage(store, target.storage, {
        admission,
        receiptPolicy: policy,
        fromRow: 0,
        prepareOriginalProvenance: true,
        apply: async () => {}
      })
    ).rejects.toThrow('one admitted native merge preparation')
    const options = {
        admission,
        receiptPolicy: policy,
        fromRow: 0,
        prepareOriginalProvenance: false,
        apply: async (_trx: Knex.Transaction) => {}
      },
      pending = commitBrc38PrivateImportPage(store, target.storage, options)
    options.prepareOriginalProvenance = true
    expect((await pending).nextRow).toBe(1)
    expect(await target.k('brc38_import_original')).toHaveLength(0)
    expect(await target.k('brc38_import_original_budget')).toHaveLength(0)
    expect((await target.k('users').first()).activeStorage).toBe('local-primary')
  })
})
