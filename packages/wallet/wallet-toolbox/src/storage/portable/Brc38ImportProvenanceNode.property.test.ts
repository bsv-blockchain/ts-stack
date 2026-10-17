import fc from 'fast-check'
import { appendFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport, readBrc38PrivateImportPreview } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import {
  installBrc38ImportProvenanceSchema,
  prepareBrc38ImportOriginals,
  readBrc38ImportOriginal,
  verifyBrc38ImportProvenanceSchema
} from './Brc38ImportProvenanceNode'
import { brc38ImportDestinationDigest, prepareBrc38PrivateImportJournal } from './Brc38PrivateImportJournalNode'
import {
  readBrc38ImportJournal,
  prepareBrc38ImportJournal,
  type Brc38ImportJournalAdmission
} from './Brc38ImportJournal'
import { brc38ImportTableOrder, prepareBrc38ImportPage } from './Brc38ImportPage'
import type { Brc38ImportDecodedBudget } from './Brc38ImportEntityMergeNode'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
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

// Each preparation reads the actual authenticated archive. Every generated
// transaction rolls back; this leaf never activates the original primary or
// sync-state history, and does not claim full restore or merge integration.
async function prepared(trx: Knex.Transaction, fromRow: number, budget: Brc38ImportDecodedBudget) {
  return await store().withAuthenticatedImportRead(async (_json, metadata, reader) => {
    const page = await prepareBrc38ImportPage(reader, metadata, admission, fromRow)
    return await page.consume(async data => {
      const original = data.kind === 'header' ? data.original : await reader.row(data.table, data.fromIndex)
      if (original === undefined) throw new Error('Authenticated original fixture row missing')
      const value = await prepareBrc38ImportOriginals(trx, reader, admission, data, fromRow, budget)
      return { ...value, original, table: data.kind === 'header' ? 'header' : data.table }
    })
  })
}
const allowance = (signal?: AbortSignal): Brc38ImportDecodedBudget => ({
  maximum: 65536,
  remaining: 65536,
  signal
})
async function begin() {
  await open()
  await prepare()
  expect(await target.k('brc38_import_original')).toEqual([])
  expect(await target.k('brc38_import_original_budget')).toEqual([])
}

test('generated authenticated header and all thirteen table originals retain independent canonical bytes hashes and exact UTF8 charges', async () => {
  await begin()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 256 }), async (index, reserved) => {
      const trx = await target.writer.transaction()
      try {
        await verifyBrc38ImportProvenanceSchema(trx)
        const headerBudget = allowance()
        headerBudget.remaining -= reserved
        const header = await prepared(trx, 0, headerBudget),
          raw = canonical(header.original)
        expect(headerBudget.remaining).toBe(65536 - reserved - 256 - 8 * Buffer.byteLength(raw))
        await header.apply(trx)
        // Provenance's native prefix is independently enforced. Prepare the actual
        // archive table by its real position, then store it at the next prefix.
        const table = brc38ImportTableOrder[index],
          tableBudget = allowance()
        tableBudget.remaining -= reserved
        const original = await store().withAuthenticatedImportRead(async (_json, metadata, reader) => {
          const page = await prepareBrc38ImportPage(reader, metadata, admission, index + 1)
          return await page.consume(async data => {
            expect(data.kind).toBe('table')
            if (data.kind !== 'table') throw new Error('Expected actual archive table')
            expect(data.table).toBe(table)
            const incoming = await reader.row(table, data.fromIndex)
            const value = await prepareBrc38ImportOriginals(trx, reader, admission, data, 1, tableBudget)
            return { ...value, incoming }
          })
        })
        const tableRaw = canonical(original.incoming)
        expect(tableBudget.remaining).toBe(65536 - reserved - 256 - 8 * Buffer.byteLength(tableRaw))
        await original.apply(trx)
        const records = await trx('brc38_import_original').orderBy('sourceRow')
        expect(records).toEqual([
          {
            ...admission.scope,
            sourceRow: 0,
            tableName: 'header',
            originalJson: raw,
            sha256: digest(raw),
            logicalBytes: 512 + Buffer.byteLength(raw)
          },
          {
            ...admission.scope,
            sourceRow: 1,
            tableName: table,
            originalJson: tableRaw,
            sha256: digest(tableRaw),
            logicalBytes: 512 + Buffer.byteLength(tableRaw)
          }
        ])
        expect(await trx('brc38_import_original_budget').first()).toMatchObject({
          ...admission.scope,
          rows: 2,
          logicalBytes: 1024 + Buffer.byteLength(raw) + Buffer.byteLength(tableRaw),
          maximumRows: admission.totalRows,
          maximumLogicalBytes: JSON.parse(admission.originalLimitsJson)[1]
        })
        expect(await readBrc38ImportOriginal(trx, admission.scope, 1, Buffer.byteLength(tableRaw))).toEqual({
          tableName: table,
          originalJson: tableRaw
        })
        await expect(original.apply(trx)).rejects.toThrow('already consumed')
      } finally {
        await trx.rollback()
      }
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 30000)

test('generated prepared authority is one-use and rereads the current native budget before writer application', async () => {
  await begin()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 256 }), fc.boolean(), async (reserved, reverse) => {
      const trx = await target.writer.transaction()
      try {
        const budget = allowance()
        budget.remaining -= reserved
        const a = await prepared(trx, 0, budget),
          b = await prepared(trx, 0, allowance()),
          first = reverse ? b : a,
          second = reverse ? a : b
        await first.apply(trx)
        const records = await trx('brc38_import_original'),
          persistedBudget = await trx('brc38_import_original_budget')
        await expect(second.apply(trx)).rejects.toThrow('differs')
        await expect(second.apply(trx)).rejects.toThrow('already consumed')
        await expect(first.apply(trx)).rejects.toThrow('already consumed')
        expect(await trx('brc38_import_original')).toEqual(records)
        expect(await trx('brc38_import_original_budget')).toEqual(persistedBudget)
      } finally {
        await trx.rollback()
      }
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 30000)

test('generated fixed decoded quota and cancellation refuse before native effects and preserve transaction rollback', async () => {
  await begin()
  const before = await state(),
    exactCharge = 256 + 8 * Buffer.byteLength(canonical(rawHeader))
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 256 }), text, fc.boolean(), async (missing, suffix, preabort) => {
      const trx = await target.writer.transaction()
      try {
        const small = { maximum: 65536, remaining: exactCharge - missing }
        await expect(prepared(trx, 0, small)).rejects.toBeInstanceOf(SnapshotResourceLimitError)
        expect(await trx('brc38_import_original')).toEqual([])
        expect(await trx('brc38_import_original_budget')).toEqual([])
        const controller = new AbortController(),
          reason = new Error('provenance cancellation ' + suffix)
        if (preabort) {
          controller.abort(reason)
          await expect(prepared(trx, 0, allowance(controller.signal))).rejects.toBe(reason)
        } else {
          const value = await prepared(trx, 0, allowance(controller.signal))
          controller.abort(reason)
          await expect(value.apply(trx)).rejects.toBe(reason)
          await expect(value.apply(trx)).rejects.toThrow('already consumed')
        }
        expect(await trx('brc38_import_original')).toEqual([])
        expect(await trx('brc38_import_original_budget')).toEqual([])
      } finally {
        await trx.rollback()
      }
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 30000)

test('generated scoped bounded native reads refuse before original payload transfer and originals stay immutable', async () => {
  await begin()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('binding', 'archive', 'user', 'import', 'row', 'bytes'),
      text,
      fc.integer({ min: 1, max: 1000 }),
      async (field, suffix, nonce) => {
        const trx = await target.writer.transaction()
        try {
          const header = await prepared(trx, 0, allowance())
          await header.apply(trx)
          const raw = canonical(header.original),
            scope = { ...admission.scope },
            row = field === 'row' ? nonce : 0
          if (field === 'binding') scope.bindingSha256 = digest('binding ' + suffix)
          if (field === 'archive') scope.archiveSha256 = digest('archive ' + suffix)
          if (field === 'user') scope.userId += nonce
          if (field === 'import') scope.importId = randomUUID()
          const maximum =
              field === 'bytes'
                ? Buffer.byteLength(raw) - Math.min(nonce, Buffer.byteLength(raw) - 1)
                : Buffer.byteLength(raw),
            queries: string[] = []
          const observe = (query: { sql: string }) => {
            queries.push(query.sql)
          }
          trx.on('query', observe)
          try {
            await expect(readBrc38ImportOriginal(trx, scope, row, maximum)).rejects.toThrow('differs')
          } finally {
            trx.removeListener('query', observe)
          }
          expect(queries).toHaveLength(1)
          expect(queries[0]).toContain('CASE WHEN typeof(originalJson)')
          expect(queries[0]).not.toContain('select `tableName`, `originalJson`')
          const value = await readBrc38ImportOriginal(trx, admission.scope, 0, Buffer.byteLength(raw))
          expect(value).toEqual({ tableName: 'header', originalJson: raw })
          expect(Object.isFrozen(value)).toBe(true)
          const records = await trx('brc38_import_original'),
            budgets = await trx('brc38_import_original_budget')
          await expect(
            trx('brc38_import_original')
              .where(admission.scope)
              .update({ originalJson: raw + suffix })
          ).rejects.toThrow('immutable')
          await expect(trx('brc38_import_original').where(admission.scope).del()).rejects.toThrow('owned cleanup')
          expect(await trx('brc38_import_original')).toEqual(records)
          expect(await trx('brc38_import_original_budget')).toEqual(budgets)
        } finally {
          await trx.rollback()
        }
        expect(await state()).toEqual(before)
      }
    ),
    controls
  )
}, 30000)

// Direct native schema-unit proof. These private low-level admissions exercise
// journal/provenance constraints only; they are not authenticated public import
// handles and never activate or qualify a complete import/restore/merge.
test('generated real schema guards enforce exact prefix scope fixed quota and immutable charges without duplicate effects', async () => {
  await begin()
  const before = await state(),
    headerJson = canonical(rawHeader),
    headerCharge = 512 + Buffer.byteLength(headerJson)
  await fc.assert(
    fc.asyncProperty(
      text,
      fc.integer({ min: 1, max: 1000 }),
      fc.boolean(),
      fc.boolean(),
      async (suffix, nonce, rowBound, wrongDigest) => {
        const trx = await target.writer.transaction()
        try {
          const json = canonical({ nativeSchemaFixture: suffix, nonce }),
            charge = 512 + Buffer.byteLength(json),
            limits = JSON.parse(admission.originalLimitsJson) as number[],
            maximum = headerCharge + charge + (rowBound ? charge : 0)
          limits[1] = maximum
          const selected = {
            ...admission,
            scope: { ...admission.scope, importId: randomUUID() },
            originalLimitsJson: JSON.stringify(limits),
            totalRows: rowBound ? 2 : 3
          }
          await prepareBrc38ImportJournal(trx, selected, selected.initialDestinationSha256)
          await trx('brc38_import_original_budget').insert({
            ...selected.scope,
            maximumRows: selected.totalRows,
            maximumLogicalBytes: maximum,
            rows: 0,
            logicalBytes: 0
          })
          const header = {
            ...selected.scope,
            sourceRow: 0,
            tableName: 'header',
            originalJson: headerJson,
            sha256: digest(headerJson),
            logicalBytes: headerCharge
          }
          const emptyBudget = await trx('brc38_import_original_budget').where(selected.scope).first()
          await expect(trx('brc38_import_original').insert({ ...header, sourceRow: nonce + 1 })).rejects.toThrow(
            'prefix or quota'
          )
          await expect(
            trx('brc38_import_original').insert({
              ...header,
              bindingSha256: digest('wrong scope ' + suffix)
            })
          ).rejects.toThrow('prefix or quota')
          expect(await trx('brc38_import_original').where(selected.scope)).toEqual([])
          expect(await trx('brc38_import_original_budget').where(selected.scope).first()).toEqual(emptyBudget)
          await trx('brc38_import_original').insert(header)
          await expect(trx('brc38_import_original').insert(header)).rejects.toThrow('prefix or quota')
          const row = {
            ...selected.scope,
            sourceRow: 1,
            tableName: 'nativeSchemaFixture',
            originalJson: json,
            sha256: wrongDigest ? digest('not the original ' + suffix) : digest(json),
            logicalBytes: charge
          }
          await trx('brc38_import_original').insert(row)
          const rows = await trx('brc38_import_original').where(selected.scope).orderBy('sourceRow'),
            budget = await trx('brc38_import_original_budget').where(selected.scope).first()
          expect(rows).toEqual([header, row])
          expect(budget).toMatchObject({
            ...selected.scope,
            maximumRows: rowBound ? 2 : 3,
            maximumLogicalBytes: maximum,
            rows: 2,
            logicalBytes: headerCharge + charge
          })
          await expect(trx('brc38_import_original').insert({ ...row, sourceRow: 2 })).rejects.toThrow('prefix or quota')
          await expect(
            trx('brc38_import_original_budget')
              .where(selected.scope)
              .update({ maximumLogicalBytes: maximum + nonce })
          ).rejects.toThrow('immutable')
          await expect(trx('brc38_import_original_budget').where(selected.scope).del()).rejects.toThrow('owned cleanup')
          if (wrongDigest)
            await expect(readBrc38ImportOriginal(trx, selected.scope, 1, Buffer.byteLength(json))).rejects.toThrow(
              'differs'
            )
          else
            expect(await readBrc38ImportOriginal(trx, selected.scope, 1, Buffer.byteLength(json))).toEqual({
              tableName: 'nativeSchemaFixture',
              originalJson: json
            })
          expect(await trx('brc38_import_original').where(selected.scope).orderBy('sourceRow')).toEqual(rows)
          expect(await trx('brc38_import_original_budget').where(selected.scope).first()).toEqual(budget)
          expect((await readBrc38ImportJournal(trx, selected)).nextRow).toBe(0)
        } finally {
          await trx.rollback()
        }
        expect(await state()).toEqual(before)
      }
    ),
    controls
  )
}, 30000)
