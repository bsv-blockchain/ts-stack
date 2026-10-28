import { randomUUID } from 'node:crypto'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport, decodeBrc38PrivateImportPreview } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { installBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateImportPage
} from './Brc38PrivateImportJournalNode'
import { prepareBrc38ImportPage } from './Brc38ImportPage'
import { prepareBrc38ImportHistory } from './Brc38ImportHistory'
import { withBrc38KnexImportReadDestination } from './Brc38KnexDestinationFence'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { brc38StageTables } from './Brc38SemanticStage'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import type { BRC38WalletData } from './index'

function largeHistory(data: BRC38WalletData): void {
  const idMap: Record<number, number> = {}
  for (let index = 0; index < 5001; index++) idMap[index] = 900000 + index
  data.tables.syncStates[0].syncMap = { transaction: { count: 5001, idMap } }
}

describe('actual authenticated source history and private writer integration', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
    staged: Awaited<ReturnType<typeof previewPrivateFixture>>
  let cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close())),
      failed = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failed.length !== 0) throw new AggregateError(failed, 'History fixture retains cleanup')
  })
  async function openTarget() {
    const value = await previewDestinationFixture(installBrc38ImportTargetIndexes)
    cleanup.push(async () => await value.close())
    return value
  }
  async function openStage(transform: (data: BRC38WalletData) => void, maximumRowBytes = 65536) {
    const value = await previewPrivateFixture(undefined, transform, maximumRowBytes)
    cleanup.push(async () => await value.close())
    return value
  }
  async function admitted(
    maximumStepBytes: number,
    mode: 'restore' | 'merge' = 'restore'
  ): Promise<Brc38ImportJournalAdmission> {
    const store = staged.value.reservation.store
    await target.k.transaction(async trx => await installBrc38ImportJournalSchema(trx))
    const preview = await previewBrc38PrivateImport(store, target.storage, mode, policy),
      metadata = await store.withAuthenticatedImportView(async (_json, value) => value),
      binding = store.binding
    if (binding === undefined) throw new Error('Private binding missing')
    const admission: Brc38ImportJournalAdmission = {
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
      maximumStepRows: 128,
      maximumStepBytes,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096
    }
    await prepareBrc38PrivateImportJournal(store, target.storage, {
      admission,
      receiptPolicy: policy
    })
    return admission
  }
  test('actual BRC39 authentication and indexed source prepares a5001-reference history under the original fixed admission and zero destination writes', async () => {
    target = await openTarget()
    staged = await openStage(largeHistory, 2097152)
    const admission = await admitted(2097152),
      store = staged.value.reservation.store,
      preview = await store.withAuthenticatedImportView(async json => decodeBrc38PrivateImportPreview(store, json)),
      before = JSON.stringify(await target.k('brc38_import_journal'))
    const projection = await store.withAuthenticatedImportRead(async (_json, metadata, reader) => {
      const page = await prepareBrc38ImportPage(reader, metadata, admission, 13)
      return await page.consume(
        async data =>
          await withBrc38KnexImportReadDestination(target.storage, preview.target, policy, async (trx, actual) => {
            const receipt = await readBrc38ImportJournal(trx, admission)
            expect(brc38ImportDestinationDigest(actual)).toBe(receipt.destinationSha256)
            return await prepareBrc38ImportHistory(trx, admission.scope, data, admission.maximumStepBytes)
          })
      )
    })
    expect(projection[0]).toMatchObject({ unmappedIds: 5001, activated: false })
    expect(JSON.parse(projection[0].originalJson).transaction.count).toBe(5001)
    expect(JSON.parse(projection[0].mappedJson).transaction).toEqual({
      entityName: 'transaction',
      count: 5001,
      idMap: {}
    })
    expect(JSON.stringify(await target.k('brc38_import_journal'))).toBe(before)
    expect(await target.k('users')).toEqual([])
    expect(await target.k('brc38_import_ids')).toEqual([])
  })
  test('the original lower allocation admission refuses the same large row before any destination writes', async () => {
    target = await openTarget()
    await expect(openStage(largeHistory, 1048576)).rejects.toThrow('allocation policy')
    expect(await target.k('users')).toEqual([])
    expect(await target.k('sync_states')).toEqual([])
  })
  test('prepared notification history reaches the bounded writer with original provenance distinct from inactive mapped data', async () => {
    target = await openTarget()
    staged = await openStage(data => {
      for (const table of brc38StageTables)
        if (table !== 'provenTxReqs' && table !== 'transactions') data.tables[table] = []
      delete data.tables.provenTxReqs[0].provenTxId
      delete data.tables.transactions[0].provenTxId
    })
    const admission = await admitted(65536),
      store = staged.value.reservation.store
    await commitBrc38PrivateImportPage(store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow: 0,
      prepareEntityTargets: true,
      prepareExistingRows: true,
      apply: async (trx, data) => {
        if (data.kind !== 'header') throw new Error('Private header missing')
        await target.storage.insertUser({ ...data.user, userId: 7, activeStorage: '' }, trx)
      }
    })
    let transactionId = 0
    await commitBrc38PrivateImportPage(store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow: 1,
      prepareEntityTargets: true,
      prepareExistingRows: true,
      apply: async (trx, data, references, _history, targets, existing) => {
        if (data.kind !== 'table' || data.table !== 'transactions')
          throw new Error('Required notification transaction missing')
        expect(targets[0]).toMatchObject({ table: 'transactions', found: false })
        expect(existing).toEqual([{ table: 'transactions', allocationBytes: 0 }])
        const row = data.rows[0],
          ids = await loadBrc38ImportIdMap(trx, admission.scope, references)
        transactionId = await target.storage.insertTransaction({ ...row, userId: 7, transactionId: 0 }, trx)
        ids.map.transaction.idMap[row.transactionId] = transactionId
        await ids.persist()
      }
    })
    let sourceQueries = 0,
      applying = false
    store.knex.on('query', () => {
      if (applying) sourceQueries++
    })
    const receipt = await commitBrc38PrivateImportPage(store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow: 2,
      prepareEntityTargets: true,
      prepareExistingRows: true,
      apply: async (trx, data, references, history, targets, existing) => {
        applying = true
        try {
          if (data.kind !== 'table' || data.table !== 'provenTxReqs')
            throw new Error('Prepared notification row missing')
          expect(targets[0]).toMatchObject({ table: 'provenTxReqs', found: false })
          expect(existing).toEqual([{ table: 'provenTxReqs', allocationBytes: 0 }])
          expect(history[0]).toMatchObject({ field: 'notify', activated: false, unmappedIds: 1 })
          expect(history[0].originalJson).toBe(data.rows[0].notify)
          expect(JSON.parse(history[0].mappedJson).transactionIds).toEqual([transactionId])
          const ids = await loadBrc38ImportIdMap(trx, admission.scope, references),
            row = data.rows[0],
            id = await target.storage.insertProvenTxReq(
              { ...row, provenTxReqId: 0, notify: history[0].mappedJson },
              trx
            )
          ids.map.provenTxReq.idMap[row.provenTxReqId] = id
          await ids.persist()
        } finally {
          applying = false
        }
      }
    })
    expect(receipt).toMatchObject({ state: 'COMPLETE', nextRow: 3, mappedIds: 2 })
    expect(sourceQueries).toBe(0)
    expect((await target.k('users').first()).activeStorage).toBe('')
    expect(JSON.parse((await target.k('proven_tx_reqs').first()).notify).transactionIds).toEqual([transactionId])
    // This proves the preparatory/writer boundary, not durable full provenance
    // storage or complete thirteen-table application/activation/recovery.
  })
  test('an authenticated merge prepares the real existing transaction before writer and rechecks the receipt before mapping', async () => {
    target = await openTarget()
    await target.storage.insertUser({
      userId: 7,
      identityKey: 'original-identity',
      activeStorage: '',
      created_at: new Date(),
      updated_at: new Date()
    })
    let sourceTxid: string | undefined
    staged = await openStage(data => {
      for (const table of brc38StageTables) if (table !== 'transactions') data.tables[table] = []
      delete data.tables.transactions[0].provenTxId
      if (typeof data.tables.transactions[0].txid === 'string') sourceTxid = data.tables.transactions[0].txid
    })
    const store = staged.value.reservation.store
    if (typeof sourceTxid !== 'string') throw new Error('Incoming transaction identity missing')
    const existingId = await target.storage.insertTransaction({
      transactionId: 61,
      userId: 7,
      created_at: new Date(),
      updated_at: new Date(),
      status: 'completed',
      reference: 'existing-local-reference',
      txid: sourceTxid,
      isOutgoing: true,
      satoshis: 9,
      description: 'destination record'
    })
    const admission = await admitted(65536, 'merge')
    await commitBrc38PrivateImportPage(store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow: 0,
      prepareExistingRows: true,
      apply: async (_trx, data, _references, _history, _targets, existing) => {
        expect(data.kind).toBe('header')
        expect(existing).toEqual([])
      }
    })
    let applying = false,
      sourceQueries = 0
    store.knex.on('query', () => {
      if (applying) sourceQueries++
    })
    const receipt = await commitBrc38PrivateImportPage(store, target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow: 1,
      prepareExistingRows: true,
      apply: async (trx, data, references, _history, targets, existing) => {
        applying = true
        try {
          if (data.kind !== 'table' || data.table !== 'transactions' || existing[0]?.table !== 'transactions')
            throw new Error('Prepared authenticated existing transaction missing')
          expect(targets[0]).toMatchObject({ found: true, localId: existingId })
          expect(existing[0].row).toMatchObject({
            transactionId: existingId,
            description: 'destination record',
            reference: 'existing-local-reference'
          })
          expect(data.rows[0].description).toBe('original')
          const ids = await loadBrc38ImportIdMap(trx, admission.scope, references)
          ids.map.transaction.idMap[data.rows[0].transactionId] = existingId
          await ids.persist()
        } finally {
          applying = false
        }
      }
    })
    expect(receipt).toMatchObject({ state: 'COMPLETE', nextRow: 2, mappedIds: 1 })
    expect(sourceQueries).toBe(0)
    expect((await target.k('transactions').first()).description).toBe('destination record')
    expect((await target.k('users').first()).activeStorage).toBe('')
  })
})
