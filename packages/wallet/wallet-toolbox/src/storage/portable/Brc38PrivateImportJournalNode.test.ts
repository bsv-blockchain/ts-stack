import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import {
  readBrc38ImportJournal,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalStep
} from './Brc38ImportJournal'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateStructuredRestorePage,
  commitBrc38PrivateImportJournalStep
} from './Brc38PrivateImportJournalNode'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import type { Knex } from 'knex'

describe('actual private owner and target-bound import journal', () => {
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
    if (binding === undefined) throw new Error('Actual authenticated fixture binding missing')
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
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    try {
      await staged?.close()
    } finally {
      await target?.close()
    }
  })
  function step(fromRow: number, mappedIds = 0): Brc38ImportJournalStep {
    return {
      fromRow,
      rows: 1,
      bytes: 128,
      mappedIds,
      pageSha256: String(fromRow).padStart(64, '0')
    }
  }
  async function prepare(selected = admission) {
    return await prepareBrc38PrivateImportJournal(store(), target.storage, {
      admission: selected,
      receiptPolicy: policy
    })
  }
  async function header(trx: Knex.Transaction, activeStorage = ''): Promise<void> {
    await target.storage.insertUser(
      {
        userId: 7,
        identityKey: staged.selected.binding.identityKey,
        activeStorage,
        created_at: new Date(),
        updated_at: new Date()
      },
      trx
    )
  }
  async function commit(
    fromRow: number,
    apply: (trx: Knex.Transaction) => Promise<void>,
    mappedIds = 0,
    signal?: AbortSignal
  ) {
    return await commitBrc38PrivateImportJournalStep(store(), target.storage, {
      admission,
      receiptPolicy: policy,
      step: step(fromRow, mappedIds),
      apply,
      signal
    })
  }
  async function receipt() {
    return await target.writer.transaction(async trx => await readBrc38ImportJournal(trx, admission))
  }
  test('structured journal preparation and restore refuse the actual legacy source without native effects', async () => {
    const before = await target.k('users').select('userId'),
      parent = dirname(store().directory)
    await expect(
      prepareBrc38PrivateImportJournal(store(), target.storage, {
        admission,
        receiptPolicy: policy,
        structured: true
      })
    ).rejects.toThrow()
    await expect(
      commitBrc38PrivateStructuredRestorePage(store(), target.storage, {
        admission,
        receiptPolicy: policy,
        fromRow: 0,
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
          expiresAt: admission.expiresAt
        }
      })
    ).rejects.toThrow()
    expect(await target.k('users').select('userId')).toEqual(before)
  })
  test('actual authenticated stage count includes an explicit header and initial restore checks precede receipt writes', async () => {
    const initial = await prepare()
    expect(initial).toMatchObject({ state: 'PREPARED', nextRow: 0 })
    expect(admission.totalRows).toBeGreaterThan(1)
    expect(await target.k('users')).toEqual([])
    const row = await target.writer('brc38_import_journal').first()
    expect(JSON.parse(row.admissionJson)).toEqual(admission)
    expect((await store().withAuthenticatedImportView(async (_json, metadata) => metadata.rows)) + 1).toBe(
      admission.totalRows
    )
  })
  test('continuation uses the actual committed checkpoint after header rows exist and lost acknowledgement cannot repeat it', async () => {
    await prepare()
    const lost = new Error('Synthetic acknowledgement lost after actual fenced commit')
    await expect(
      (async () => {
        await commit(0, header)
        throw lost
      })()
    ).rejects.toBe(lost)
    const saved = await receipt(),
      apply = jest.fn()
    expect(saved).toMatchObject({ state: 'COMMITTED', nextRow: 1 })
    expect(await commit(0, apply)).toEqual(saved)
    expect(apply).not.toHaveBeenCalled()
    expect(await prepare()).toEqual(saved)
    expect(await target.writer('users')).toHaveLength(1)
    expect((await target.writer('users').first()).activeStorage).toBe('')
  })
  test('bounded native basket mapping and post-write destination cursor commit atomically', async () => {
    await prepare()
    await commit(0, header)
    const result = await commit(
      1,
      async trx => {
        const ids = await loadBrc38ImportIdMap(trx, admission.scope, [
          { entity: 'outputBasket', incomingId: 1e21, required: false }
        ])
        const local = await target.storage.insertOutputBasket(
          {
            basketId: 0,
            userId: 7,
            name: 'synthetic import',
            numberOfDesiredUTXOs: 0,
            minimumDesiredUTXOValue: 0,
            isDeleted: false,
            created_at: new Date(),
            updated_at: new Date()
          },
          trx
        )
        ids.map.outputBasket.idMap[1e21] = local
        await ids.persist()
      },
      1
    )
    expect(result).toMatchObject({ nextRow: 2, mappedIds: 1 })
    expect((await target.writer('brc38_import_journal').first()).mappedIds).toBe(1)
    expect(await receipt()).toEqual(result)
    const mapped = await target.writer('brc38_import_ids').where(admission.scope).first(),
      basket = await target.writer('output_baskets').first()
    expect(mapped.incomingId).toBe('1e+21')
    expect(mapped.localId).toBe(basket.basketId)
    expect(basket.userId).toBe(7)
  })
  test.each(['disabled', 'incomplete'] as const)(
    'post-write %s generation refuses before checkpoint publication and rolls back rows',
    async kind => {
      await prepare()
      const initial = await receipt()
      await expect(
        commit(0, async trx => {
          await header(trx)
          if (kind === 'disabled')
            await trx('snapshot_journal_clock').update({ enabled: 0, reason: 'capacity-exhausted' })
          else await trx('snapshot_journal_generation').update({ complete: 0 })
        })
      ).rejects.toThrow()
      expect(await target.writer('users')).toEqual([])
      expect(await receipt()).toEqual(initial)
      expect((await target.writer('snapshot_journal_clock').first()).enabled).toBe(1)
      expect((await target.writer('snapshot_journal_generation').first()).complete).toBe(1)
    }
  )
  test('source primary values cannot promote an imported profile and a later independent ABA is refused', async () => {
    await prepare()
    await expect(commit(0, async trx => await header(trx, 'foreign source primary'))).rejects.toThrow('differs')
    expect(await target.writer('users')).toEqual([])
    await commit(0, header)
    await target.writer('users').where({ userId: 7 }).update({ activeStorage: 'independent primary' })
    await target.writer('users').where({ userId: 7 }).update({ activeStorage: '' })
    const apply = jest.fn()
    await expect(commit(1, apply)).rejects.toThrow('differs')
    expect(apply).not.toHaveBeenCalled()
    expect((await receipt()).nextRow).toBe(1)
  })
  test('untracked monitor occupancy still invalidates initial restore admission', async () => {
    await target.storage.insertMonitorEvent({
      id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      event: 'synthetic late occupancy',
      details: 'independent writer'
    })
    await expect(prepare()).rejects.toThrow('empty target')
    expect(await target.writer('brc38_import_journal')).toEqual([])
  })
  test.each(['binding', 'archive', 'preview', 'count', 'limits'] as const)(
    'actual private owner refuses mismatched %s before target admission',
    async field => {
      const changed = { ...admission, scope: { ...admission.scope } }
      if (field === 'binding') changed.scope.bindingSha256 = 'c'.repeat(64)
      if (field === 'archive') changed.scope.archiveSha256 = 'c'.repeat(64)
      if (field === 'preview') changed.previewId = randomUUID()
      if (field === 'count') changed.totalRows--
      if (field === 'limits') changed.originalLimitsJson += ' '
      await expect(prepare(changed)).rejects.toThrow('differs')
      expect(await target.writer('brc38_import_journal')).toEqual([])
    }
  )
  test('superseded private preview cannot initialize or continue its old operation', async () => {
    await prepare()
    await previewBrc38PrivateImport(store(), target.storage, 'restore', policy)
    await expect(prepare()).rejects.toThrow('differs')
    await expect(commit(0, header)).rejects.toThrow('differs')
    expect((await receipt()).nextRow).toBe(0)
    expect(await target.writer('users')).toEqual([])
  })
  test('private ownership remains busy throughout held destination I/O and cancellation waits for real rollback', async () => {
    await prepare()
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => {
        release = resolve
      }),
      ready = new Promise<void>(resolve => {
        entered = resolve
      }),
      controller = new AbortController(),
      reason = new Error('Synthetic cancel while actual writer held')
    const work = commit(
      0,
      async trx => {
        await header(trx)
        entered()
        await held
      },
      0,
      controller.signal
    )
    try {
      await ready
      await expect(store().close()).rejects.toThrow('Wait for owned')
      await expect(store().readImportPreview()).rejects.toThrow('already owned')
      controller.abort(reason)
    } finally {
      release()
    }
    await expect(work).rejects.toBe(reason)
    expect(await target.writer('users')).toEqual([])
    expect((await receipt()).nextRow).toBe(0)
    expect((await commit(0, header)).nextRow).toBe(1)
  })
  test('a fully authenticated archive with empty table arrays still requires its explicit header before COMPLETE', async () => {
    await staged.close()
    staged = await previewPrivateFixture(undefined, data => {
      for (const key of Object.keys(data.tables) as Array<keyof typeof data.tables>) data.tables[key] = []
    })
    const preview = await previewBrc38PrivateImport(store(), target.storage, 'restore', policy),
      binding = store().binding
    if (binding === undefined) throw new Error('Actual empty archive binding missing')
    admission = {
      ...admission,
      scope: {
        ...admission.scope,
        bindingSha256: binding.digest,
        archiveSha256: binding.binding.archiveSha256
      },
      previewId: preview.previewId,
      originalLimitsJson: binding.limitsJson,
      expiresAt: preview.expiresAt,
      initialDestinationSha256: brc38ImportDestinationDigest(preview.target),
      totalRows: 1
    }
    expect(await store().withAuthenticatedImportView(async (_json, metadata) => metadata.rows)).toBe(0)
    expect((await prepare()).state).toBe('PREPARED')
    const complete = await commit(0, header)
    expect(complete).toMatchObject({ state: 'COMPLETE', nextRow: 1, mappedIds: 0 })
    expect((await target.writer('users').first()).identityKey).toBe(staged.selected.binding.identityKey)
    expect((await target.writer('users').first()).activeStorage).toBe('')
    expect(await receipt()).toEqual(complete)
  })
})
