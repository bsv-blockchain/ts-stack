import { randomUUID } from 'node:crypto'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateImportPage
} from './Brc38PrivateImportJournalNode'
import type { Brc38PreparedImportData } from './Brc38ImportPage'
import { loadBrc38ImportIdMap, type Brc38ImportIdReference } from './Brc38ImportIdMap'
import type { Knex } from 'knex'
describe('actual same-owner bounded source preparation and destination commit', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
    staged: Awaited<ReturnType<typeof previewPrivateFixture>>,
    admission: Brc38ImportJournalAdmission
  const store = () => staged.value.reservation.store
  beforeEach(async () => {
    target = await previewDestinationFixture()
    staged = await previewPrivateFixture()
    await target.k.transaction(async trx => await installBrc38ImportJournalSchema(trx))
    const preview = await previewBrc38PrivateImport(store(), target.storage, 'restore', policy),
      metadata = await store().withAuthenticatedImportView(async (_json, value) => value),
      binding = store().binding
    if (binding === undefined) throw new Error('Fixture binding missing')
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
      maximumStepRows: 128,
      maximumStepBytes: 65536,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096
    }
    await prepareBrc38PrivateImportJournal(store(), target.storage, {
      admission,
      receiptPolicy: policy
    })
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    try {
      await staged?.close()
    } finally {
      await target?.close()
    }
  })
  async function header(trx: Knex.Transaction, data: Brc38PreparedImportData): Promise<void> {
    if (data.kind !== 'header') throw new Error('Prepared header missing')
    await target.storage.insertUser({ ...data.user, userId: 7, activeStorage: '' }, trx)
  }
  async function commit(
    fromRow: number,
    apply: (
      trx: Knex.Transaction,
      data: Brc38PreparedImportData,
      refs: readonly Brc38ImportIdReference[]
    ) => Promise<void>,
    signal?: AbortSignal
  ) {
    return await commitBrc38PrivateImportPage(store(), target.storage, {
      admission,
      receiptPolicy: policy,
      fromRow,
      apply,
      signal
    })
  }
  async function receipt() {
    return await target.writer.transaction(async trx => await readBrc38ImportJournal(trx, admission))
  }
  test('actual encrypted stage prepares header/native proof before writer and commits rows/mappings/checkpoint without source reads during apply', async () => {
    let applying = false,
      sourceQueriesInApply = 0
    store().knex.on('query', () => {
      if (applying) sourceQueriesInApply++
    })
    const first = await commit(0, async (trx, data) => {
      applying = true
      try {
        await header(trx, data)
      } finally {
        applying = false
      }
    })
    expect(first.nextRow).toBe(1)
    expect((await target.writer('users').first()).activeStorage).toBe('')
    const proof = await commit(1, async (trx, data, refs) => {
      applying = true
      try {
        if (data.kind !== 'table' || data.table !== 'provenTxs') throw new Error('Prepared proof missing')
        const ids = await loadBrc38ImportIdMap(trx, admission.scope, refs)
        for (const row of data.rows) {
          const id = await target.storage.insertProvenTx({ ...row, provenTxId: 0 }, trx)
          ids.map.provenTx.idMap[row.provenTxId] = id
        }
        await ids.persist()
      } finally {
        applying = false
      }
    })
    expect(proof).toMatchObject({ nextRow: 2, mappedIds: 1 })
    expect(sourceQueriesInApply).toBe(0)
    const row = await target.writer('proven_txs').first()
    expect(Array.from(row.rawTx as Uint8Array)).toEqual([1, 2])
    expect(await receipt()).toEqual(proof)
  })
  test('lost acknowledgement after prepared header commit replays the exact page without applying it again', async () => {
    const first = await commit(0, header),
      again = jest.fn()
    expect(await commit(0, again)).toEqual(first)
    expect(again).not.toHaveBeenCalled()
    expect(await target.writer('users')).toHaveLength(1)
  })
  test('late untracked target occupancy after PREPARED cannot bypass the first restore empty-target check', async () => {
    await target.storage.insertMonitorEvent({
      id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      event: 'synthetic late occupancy',
      details: 'independent destination writer'
    })
    const apply = jest.fn()
    await expect(commit(0, apply)).rejects.toThrow('empty target')
    expect(apply).not.toHaveBeenCalled()
    expect(await target.writer('users')).toEqual([])
    expect((await receipt()).state).toBe('PREPARED')
  })
  test('prepared source primary cannot promote the destination and the failed header rolls back', async () => {
    await expect(
      commit(0, async (trx, data) => {
        if (data.kind !== 'header') throw new Error('Header missing')
        await target.storage.insertUser({ ...data.user, userId: 7, activeStorage: 'original source primary' }, trx)
      })
    ).rejects.toThrow('differs')
    expect(await target.writer('users')).toEqual([])
    expect((await receipt()).nextRow).toBe(0)
  })
  test('cancellation after bounded source preparation and before checkpoint publication preserves the original receipt', async () => {
    const abort = new AbortController(),
      reason = new Error('Synthetic cancellation')
    await expect(
      commit(
        0,
        async (trx, data) => {
          await header(trx, data)
          abort.abort(reason)
        },
        abort.signal
      )
    ).rejects.toBe(reason)
    expect(await target.writer('users')).toEqual([])
    expect((await receipt()).nextRow).toBe(0)
  })
})
