import fc from 'fast-check'
import { appendFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport, readBrc38PrivateImportPreview } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { installBrc38ImportProvenanceSchema } from './Brc38ImportProvenanceNode'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateImportJournalStep,
  commitBrc38PrivateImportPage,
  commitBrc38PrivateImportRestorePage,
  commitBrc38PrivateImportMergePage,
  commitBrc38PrivateImportEntityPage
} from './Brc38PrivateImportJournalNode'
import { readBrc38ImportJournal, type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import type { BRC38WalletData } from './index'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
const text = fc
  .array(fc.constantFrom('x', 'é', '中', '😀', '"', '\\', '\n'), {
    minLength: 1,
    maxLength: 12
  })
  .map(parts => parts.join(''))
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
// Independent RFC 8785 oracle for the ordinary authenticated fixture values.
// It does not call the production chunk encoder, page builder or journal codec.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error('Independent oracle requires JSON values')
    return json
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return (
    '{' +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') +
    '}'
  )
}
let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
  staged: Awaited<ReturnType<typeof previewPrivateFixture>>,
  admission: Brc38ImportJournalAdmission,
  rawHeader: Readonly<BRC38WalletData>,
  originalPhysicalReservation: number,
  openedTarget = false,
  openedStage = false
const store = () => staged.value.reservation.store
const prepare = (selected = admission) =>
  prepareBrc38PrivateImportJournal(store(), target.storage, {
    admission: selected,
    receiptPolicy: policy
  })
const restoreHeader = () =>
  commitBrc38PrivateImportRestorePage(store(), target.storage, {
    admission,
    receiptPolicy: policy,
    fromRow: 0
  })
async function receipt() {
  return await target.writer.transaction(async trx => await readBrc38ImportJournal(trx, admission))
}
async function state() {
  return {
    journal: await target.k('brc38_import_journal').orderBy('importId'),
    ids: await target.k('brc38_import_ids').orderBy('incomingId'),
    originals: await target.k('brc38_import_original').orderBy('sourceRow'),
    budgets: await target.k('brc38_import_original_budget').orderBy('importId'),
    users: await target.k('users').orderBy('userId'),
    baskets: await target.k('output_baskets').orderBy('basketId'),
    monitors: await target.k('monitor_events').orderBy('id'),
    clock: await target
      .k('snapshot_journal_clock')
      .first(
        'id',
        'enabled',
        'reason',
        target.k.raw('CAST(revision AS TEXT) revision'),
        target.k.raw('CAST(ceiling AS TEXT) ceiling')
      ),
    generation: await target.k('snapshot_journal_generation').first(),
    epochs: await target.k('snapshot_sync_primary_epochs').orderBy('userId'),
    metadata: await store().knex('metadata').first(),
    preview: await readBrc38PrivateImportPreview(store()),
    usage: await staged.root.usage()
  }
}
async function open(empty = false) {
  target = await previewDestinationFixture(async trx => {
    await installBrc38ImportJournalSchema(trx)
    await installBrc38ImportProvenanceSchema(trx)
  })
  openedTarget = true
  staged = await previewPrivateFixture(undefined, data => {
    if (empty) for (const key of Object.keys(data.tables) as Array<keyof typeof data.tables>) data.tables[key] = []
  })
  openedStage = true
  originalPhysicalReservation = (await staged.root.usage()).physicalBytes
  if (process.env.TMPDIR === '/work/fixtures')
    for (const path of [target.directory, staged.directory])
      await appendFile('/work/validation/fixture-record.jsonl', JSON.stringify({ path }) + '\n')
  const preview = await previewBrc38PrivateImport(store(), target.storage, 'restore', policy)
  rawHeader = await store().withAuthenticatedImportRead(async (_json, _metadata, reader) => {
    return await reader.header()
  })
  const metadata = await store().withAuthenticatedImportView(async (_json, value) => value),
    binding = store().binding,
    userId = rawHeader.user.userId
  if (binding === undefined || typeof userId !== 'number' || !Number.isSafeInteger(userId))
    throw new Error('Actual authenticated header or binding missing')
  admission = {
    scope: {
      importId: randomUUID(),
      bindingSha256: binding.digest,
      archiveSha256: binding.binding.archiveSha256,
      userId
    },
    previewId: preview.previewId,
    originalLimitsJson: binding.limitsJson,
    expiresAt: preview.expiresAt,
    initialDestinationSha256: digest(JSON.stringify(preview.target)),
    totalRows: metadata.rows + 1,
    maximumStepRows: 128,
    maximumStepBytes: 65536,
    maximumMappedIds: 1000,
    maximumJournalLogicalBytes: 516096
  }
  expect(brc38ImportDestinationDigest(preview.target)).toBe(admission.initialDestinationSha256)
  expect(admission.expiresAt).toBe(store().limits.expiresAt)
  expect((await staged.root.usage()).imports).toBe(1)
}
beforeEach(() => {
  openedTarget = false
  openedStage = false
})
afterEach(async () => {
  const directories = [openedTarget ? target.directory : undefined, openedStage ? staged.directory : undefined].filter(
    (path): path is string => path !== undefined
  )
  try {
    if (openedStage) {
      await staged.root.discard(staged.value.reservation, new Error('generated journal cleanup'))
      expect(await staged.root.usage()).toEqual({
        imports: 0,
        physicalBytes: originalPhysicalReservation - staged.selected.limits.maximumPhysicalBytes,
        logicalBytes: 0
      })
    }
  } finally {
    try {
      if (openedStage) await staged.close()
    } finally {
      if (openedTarget) await target.close()
    }
  }
  for (const directory of directories) await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('generated bound admissions refuse before a real independent destination writer and preserve every durable charge', async () => {
  await open()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('binding', 'archive', 'preview', 'limits', 'expiry', 'count', 'destination'),
      text,
      fc.integer({ min: 1, max: 1000 }),
      async (field, suffix, nonce) => {
        const selected = { ...admission, scope: { ...admission.scope } }
        if (field === 'binding') selected.scope.bindingSha256 = digest('binding' + suffix)
        if (field === 'archive') selected.scope.archiveSha256 = digest('archive' + suffix)
        if (field === 'preview') selected.previewId = randomUUID()
        if (field === 'limits') selected.originalLimitsJson += ' '.repeat(nonce)
        if (field === 'expiry') selected.expiresAt += nonce
        if (field === 'count') selected.totalRows += nonce
        if (field === 'destination') selected.initialDestinationSha256 = digest(suffix)
        const writer = await target.writer.transaction()
        try {
          await writer('snapshot_journal_clock').update({ revision: writer.ref('revision') })
          await expect(prepare(selected)).rejects.toThrow('differs')
        } finally {
          await writer.rollback()
        }
        expect(await state()).toEqual(before)
      }
    ),
    controls
  )
}, 180000)

test('generated lost acknowledgement replays the actual native header and original provenance checkpoint without repeated writes', async () => {
  await open()
  expect((await prepare()).state).toBe('PREPARED')
  const raw = canonical(rawHeader),
    pageSha256 = createHash('sha256')
      .update(
        JSON.stringify([
          'brc38-prepared-import-page/v1',
          admission.scope.importId,
          admission.scope.bindingSha256,
          admission.scope.archiveSha256,
          admission.scope.userId,
          admission.previewId,
          0
        ])
      )
      .update(raw)
      .digest('hex'),
    acknowledged = await restoreHeader(),
    before = await state()
  expect(acknowledged).toMatchObject({
    state: 'COMMITTED',
    sequence: 1,
    nextRow: 1,
    mappedIds: 0,
    logicalBytes: 4096,
    lastStep: { fromRow: 0, rows: 1, bytes: Buffer.byteLength(raw), mappedIds: 0, pageSha256 }
  })
  expect(before.users).toHaveLength(1)
  expect(before.users[0]).toMatchObject({
    userId: admission.scope.userId,
    identityKey: staged.selected.binding.identityKey,
    activeStorage: ''
  })
  expect(before.originals).toEqual([
    {
      ...admission.scope,
      sourceRow: 0,
      tableName: 'header',
      originalJson: raw,
      sha256: digest(raw),
      logicalBytes: 512 + Buffer.byteLength(raw)
    }
  ])
  expect(before.budgets[0]).toMatchObject({ rows: 1, logicalBytes: 512 + Buffer.byteLength(raw) })
  expect(before.journal[0].receiptJson).toBe(JSON.stringify(acknowledged))
  expect(before.journal[0].receiptSha256).toBe(digest(JSON.stringify(acknowledged)))
  await fc.assert(
    fc.asyncProperty(text, fc.boolean(), async (suffix, wrapper) => {
      const lost = new Error('Generated acknowledgement loss ' + suffix)
      let repeated = 0
      await expect(
        (async () => {
          const replay = wrapper
            ? await restoreHeader()
            : await commitBrc38PrivateImportPage(store(), target.storage, {
                admission,
                receiptPolicy: policy,
                fromRow: 0,
                apply: async () => {
                  repeated++
                }
              })
          expect(replay).toEqual(acknowledged)
          throw lost
        })()
      ).rejects.toBe(lost)
      expect(repeated).toBe(0)
      expect(await prepare()).toEqual(acknowledged)
      expect(await receipt()).toEqual(acknowledged)
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 180000)

test('generated callback cancellation and rejected post-write fences atomically roll back native rows mappings and cursor', async () => {
  await open()
  await prepare()
  await restoreHeader()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('throw', 'cancel', 'disabled', 'incomplete', 'primary'),
      text,
      fc.integer({ min: 1, max: 100000 }),
      async (kind, suffix, nonce) => {
        const controller = new AbortController(),
          reason = new Error('Generated journal rollback ' + suffix),
          incomingId = 1e21 + nonce * 1048576
        let entered = 0
        await expect(
          commitBrc38PrivateImportJournalStep(store(), target.storage, {
            admission,
            receiptPolicy: policy,
            step: {
              fromRow: 1,
              rows: 1,
              bytes: 128 + Buffer.byteLength(suffix),
              mappedIds: 1,
              pageSha256: digest(JSON.stringify([kind, suffix, nonce]))
            },
            signal: controller.signal,
            apply: async trx => {
              entered++
              const loaded = await loadBrc38ImportIdMap(trx, admission.scope, [
                  { entity: 'outputBasket', incomingId, required: false }
                ]),
                localId = await target.storage.insertOutputBasket(
                  {
                    basketId: 0,
                    userId: admission.scope.userId,
                    name: suffix,
                    numberOfDesiredUTXOs: 0,
                    minimumDesiredUTXOValue: 0,
                    isDeleted: false,
                    created_at: new Date(1700000000000 + nonce),
                    updated_at: new Date(1700000000000 + nonce)
                  },
                  trx
                )
              loaded.map.outputBasket.idMap[incomingId] = localId
              await loaded.persist()
              expect((await trx('brc38_import_journal').first()).mappedIds).toBe(1)
              await expect(store().close()).rejects.toThrow('owned private')
              await expect(store().readImportPreview()).rejects.toThrow('already owned')
              await expect(target.writer('settings').update({ storageName: suffix })).rejects.toMatchObject({
                code: 'SQLITE_BUSY'
              })
              if (kind === 'throw') throw reason
              if (kind === 'cancel') controller.abort(reason)
              if (kind === 'disabled')
                await trx('snapshot_journal_clock').update({
                  enabled: 0,
                  reason: 'capacity-exhausted'
                })
              if (kind === 'incomplete') await trx('snapshot_journal_generation').update({ complete: 0 })
              if (kind === 'primary')
                await trx('users').where({ userId: admission.scope.userId }).update({ activeStorage: suffix })
            }
          })
        ).rejects.toThrow()
        expect(entered).toBe(1)
        expect(await state()).toEqual(before)
      }
    ),
    controls
  )
}, 180000)

test('generated exact native restore replay preserves COMPLETE for an authenticated empty archive and superseded admission refuses', async () => {
  await open(true)
  expect(admission.totalRows).toBe(1)
  expect((await prepare()).state).toBe('PREPARED')
  const complete = await restoreHeader(),
    before = await state()
  expect(complete).toMatchObject({ state: 'COMPLETE', sequence: 1, nextRow: 1, mappedIds: 0 })
  expect(before.users).toHaveLength(1)
  expect(before.originals).toHaveLength(1)
  expect(before.ids).toEqual([])
  await fc.assert(
    fc.asyncProperty(text, fc.boolean(), async (suffix, abort) => {
      const controller = new AbortController(),
        reason = new Error(suffix)
      if (abort) controller.abort(reason)
      const work = commitBrc38PrivateImportRestorePage(store(), target.storage, {
        admission,
        receiptPolicy: policy,
        fromRow: 0,
        signal: controller.signal
      })
      if (abort) await expect(work).rejects.toBe(reason)
      else expect(await work).toEqual(complete)
      expect(await prepare()).toEqual(complete)
      expect(await state()).toEqual(before)
    }),
    controls
  )
  await previewBrc38PrivateImport(store(), target.storage, 'merge', policy)
  await expect(prepare()).rejects.toThrow('differs')
  await expect(restoreHeader()).rejects.toThrow('differs')
  expect(await receipt()).toEqual(complete)
  expect(await target.k('brc38_import_original')).toEqual(before.originals)
}, 180000)

test('generated page bounds mode guards and pre-aborted calls refuse without callback or destination effects', async () => {
  await open()
  await prepare()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('merge', 'entity', 'originals', 'negative', 'past', 'zero', 'large', 'abort'),
      text,
      fc.integer({ min: 1, max: 1000 }),
      async (kind, suffix, nonce) => {
        const controller = new AbortController(),
          reason = new Error(suffix)
        if (kind === 'abort') controller.abort(reason)
        let applied = 0
        const work =
          kind === 'merge'
            ? commitBrc38PrivateImportMergePage(store(), target.storage, {
                admission,
                receiptPolicy: policy,
                fromRow: 0
              })
            : kind === 'entity'
              ? commitBrc38PrivateImportEntityPage(store(), target.storage, {
                  admission,
                  receiptPolicy: policy,
                  fromRow: 0
                })
              : commitBrc38PrivateImportPage(store(), target.storage, {
                  admission,
                  receiptPolicy: policy,
                  fromRow: kind === 'negative' ? -nonce : kind === 'past' ? admission.totalRows + nonce : 0,
                  maximumPreparedRows:
                    kind === 'zero' ? 0 : kind === 'large' ? admission.maximumStepRows + nonce : undefined,
                  prepareOriginalProvenance: kind === 'originals',
                  signal: controller.signal,
                  apply: async () => {
                    applied++
                  }
                })
        if (kind === 'abort') await expect(work).rejects.toBe(reason)
        else await expect(work).rejects.toThrow()
        expect(applied).toBe(0)
        expect(await state()).toEqual(before)
      }
    ),
    controls
  )
}, 180000)
