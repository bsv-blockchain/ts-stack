import fc from 'fast-check'
import { appendFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { installBrc38ImportProvenanceSchema } from './Brc38ImportProvenanceNode'
import { installBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { brc38ImportDestinationDigest, prepareBrc38PrivateImportJournal } from './Brc38PrivateImportJournalNode'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { prepareBrc38ImportPage } from './Brc38ImportPage'
import { prepareBrc38ImportMergeCheckpoint } from './Brc38ImportMergeCheckpointNode'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import type { Brc38ImportDecodedBudget } from './Brc38ImportEntityMergeNode'
import { EntitySyncState } from '../schema/entities/EntitySyncState'
import { createSyncMap } from '../schema/entities/EntityBase'
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
const name = fc.array(fc.constantFrom('x', 'é', '中', '😀'), { minLength: 1, maxLength: 8 }).map(v => v.join(''))
let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
  staged: Awaited<ReturnType<typeof previewPrivateFixture>>,
  admission: Brc38ImportJournalAdmission,
  header: Readonly<BRC38WalletData>,
  openedTarget = false,
  openedStage = false,
  originalPhysicalReservation: number
const store = () => staged.value.reservation.store
const budget = (signal?: AbortSignal): Brc38ImportDecodedBudget => ({
  maximum: 262144,
  remaining: 262144,
  signal
})
beforeEach(() => {
  openedTarget = false
  openedStage = false
})
afterEach(async () => {
  const paths = [openedTarget ? target.directory : undefined, openedStage ? staged.directory : undefined].filter(
    (p): p is string => p !== undefined
  )
  try {
    if (openedStage) {
      await staged.root.discard(staged.value.reservation, new Error('checkpoint property cleanup'))
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
  for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
async function open(empty = false) {
  target = await previewDestinationFixture(async trx => {
    await installBrc38ImportTargetIndexes(trx)
    await installBrc38ImportJournalSchema(trx)
    await installBrc38ImportProvenanceSchema(trx)
  })
  openedTarget = true
  await target.storage.insertUser({
    userId: 7,
    identityKey: 'original-identity',
    activeStorage: 'local-primary',
    created_at: new Date(0),
    updated_at: new Date(0)
  })
  staged = await previewPrivateFixture(
    undefined,
    data => {
      if (empty)
        for (const table of Object.keys(data.tables) as Array<keyof typeof data.tables>) data.tables[table] = []
    },
    262144
  )
  openedStage = true
  originalPhysicalReservation = (await staged.root.usage()).physicalBytes
  if (process.env.TMPDIR === '/work/fixtures')
    for (const path of [target.directory, staged.directory])
      await appendFile('/work/validation/fixture-record.jsonl', JSON.stringify({ path }) + '\n')
  const preview = await previewBrc38PrivateImport(store(), target.storage, 'merge', policy)
  header = await store().withAuthenticatedImportRead(async (_json, _metadata, reader) => await reader.header())
  const binding = store().binding,
    metadata = await store().withAuthenticatedImportView(async (_json, value) => value)
  if (binding === undefined || header.user.userId !== 7 || header.user.identityKey !== 'original-identity')
    throw new Error('Actual checkpoint fixture binding differs')
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
    maximumStepBytes: 262144,
    maximumMappedIds: 1000,
    maximumJournalLogicalBytes: 516096
  }
  await prepareBrc38PrivateImportJournal(store(), target.storage, {
    admission,
    receiptPolicy: policy
  })
}
async function state() {
  return {
    users: await target.k('users').orderBy('userId'),
    sources: await target.k('sync_states').orderBy('syncStateId'),
    ids: await target.k('brc38_import_ids').orderBy('incomingId'),
    journal: await target.k('brc38_import_journal').orderBy('importId'),
    usage: await staged.root.usage()
  }
}
async function insertSource(
  trx: Knex.Transaction,
  storageName: BRC38WalletData['sourceStorage']['storageName'],
  count = 0,
  incomingId?: number,
  localId?: number
) {
  if (typeof storageName !== 'string') throw new Error('Actual source storage name must be a string')
  const source = new EntitySyncState()
  Object.assign(source.api, {
    userId: 7,
    storageIdentityKey: header.sourceStorage.storageIdentityKey,
    storageName,
    refNum: 'retained-ref',
    created_at: new Date(0),
    updated_at: new Date(0),
    when: new Date(0)
  })
  source.syncMap = createSyncMap()
  source.syncMap.outputBasket.count = count
  if (incomingId !== undefined && localId !== undefined) source.syncMap.outputBasket.idMap[incomingId] = localId
  await target.storage.insertSyncState(source.toApi(), trx)
}
async function checkpoint(trx: Knex.Transaction, fromRow: number, done: boolean, allowance = budget()) {
  const modes: Array<{ query_only: number }> = await trx.raw('PRAGMA query_only')
  if (modes.length !== 1 || modes[0].query_only !== 0)
    throw new Error('Checkpoint fixture requires its original writable phase')
  // Direct checkpoint unit: one owned native transaction is query-only during
  // preparation and restored before apply. This does not prove the complete
  // coordinator's independent read/writer scheduling or foreground fairness.
  await trx.raw('PRAGMA query_only=ON')
  try {
    return await store().withAuthenticatedImportRead(async (_json, metadata, reader) => {
      const page = await prepareBrc38ImportPage(reader, metadata, admission, fromRow)
      return await page.consume(async data => {
        const actualSource =
          data.kind === 'header'
            ? data.source
            : await (
                await prepareBrc38ImportPage(reader, metadata, admission, 0)
              ).consume(async headerData => {
                if (headerData.kind !== 'header') throw new Error('Actual source header required')
                return headerData.source
              })
        const value = await prepareBrc38ImportMergeCheckpoint(
          trx,
          target.storage,
          admission,
          data,
          page.references,
          actualSource,
          reader,
          done,
          allowance
        )
        return { value, data, references: page.references }
      })
    })
  } finally {
    await trx.raw('PRAGMA query_only=OFF')
  }
}
// Actual independently authenticated staging and source-owned native schema only.
// Each generated native transaction rolls back. This component source does not
// establish full13-table merge, activation, process-loss or provider qualification.
test('generated actual authenticated headers create one-use native source checkpoints without replacing the primary', async () => {
  await open(true)
  const before = await state()
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 256 }), async reserved => {
      const trx = await target.writer.transaction()
      try {
        const allowance = budget()
        allowance.remaining -= reserved
        const { value } = await checkpoint(trx, 0, false, allowance)
        expect(allowance.remaining).toBeLessThan(allowance.maximum - reserved)
        await value.assert(trx)
        await value.apply(trx)
        const rows = await trx('sync_states')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          userId: 7,
          storageIdentityKey: header.sourceStorage.storageIdentityKey,
          storageName: header.sourceStorage.storageName
        })
        const map = JSON.parse(rows[0].syncMap)
        expect(Object.keys(map).sort()).toEqual(Object.keys(createSyncMap()).sort())
        for (const item of Object.values(map) as Array<{ count: number; idMap: object }>) {
          expect(item.count).toBe(0)
          expect(item.idMap).toEqual({})
        }
        expect((await trx('users').where({ userId: 7 }).first()).activeStorage).toBe('local-primary')
        await expect(value.apply(trx)).rejects.toThrow('already consumed')
      } finally {
        await trx.rollback()
      }
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 30000)
test('generated renamed source retains its prior identity reference and map while stale prior state refuses', async () => {
  await open()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(name, fc.integer({ min: 0, max: 12 }), fc.boolean(), async (oldName, count, remove) => {
      const trx = await target.writer.transaction()
      try {
        await insertSource(trx, oldName, count)
        const prior = await trx('sync_states').first(),
          { value } = await checkpoint(trx, 0, false)
        await value.assert(trx)
        await value.apply(trx)
        const saved = await trx('sync_states').first()
        expect(saved.syncStateId).toBe(prior.syncStateId)
        expect(saved.refNum).toBe('retained-ref')
        expect(saved.storageName).toBe(header.sourceStorage.storageName)
        expect(JSON.parse(saved.syncMap).outputBasket.count).toBe(count)
        const next = await checkpoint(trx, 0, false)
        if (remove) await trx('sync_states').where({ syncStateId: saved.syncStateId }).delete()
        else {
          const map = JSON.parse(saved.syncMap)
          map.outputBasket.count += 1
          await trx('sync_states')
            .where({ syncStateId: saved.syncStateId })
            .update({ syncMap: JSON.stringify(map) })
        }
        await expect(next.value.assert(trx)).rejects.toThrow('checkpoint differs')
      } finally {
        await trx.rollback()
      }
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 30000)
test('generated actual durable ID mapping increments or finalizes the bounded source map and rejects prior mapping conflicts', async () => {
  await open()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 0, max: 12 }),
      fc.boolean(),
      fc.boolean(),
      async (localId, count, done, conflict) => {
        const trx = await target.writer.transaction()
        try {
          const incoming = await store().withAuthenticatedImportRead(async (_json, metadata, reader) => {
            const page = await prepareBrc38ImportPage(reader, metadata, admission, 2)
            return await page.consume(async data => {
              if (data.kind !== 'table' || data.table !== 'outputBaskets')
                throw new Error('Actual basket page required')
              return data.rows[0]
            })
          })
          await insertSource(
            trx,
            header.sourceStorage.storageName,
            count,
            incoming.basketId,
            conflict ? localId + 1 : localId
          )
          const refs = [{ entity: 'outputBasket' as const, incomingId: incoming.basketId, required: false }],
            loaded = await loadBrc38ImportIdMap(trx, admission.scope, refs)
          loaded.map.outputBasket.idMap[incoming.basketId] = localId
          await loaded.persist()
          const { value } = await checkpoint(trx, 2, done)
          await value.assert(trx)
          if (conflict) await expect(value.apply(trx)).rejects.toThrow('checkpoint differs')
          else {
            await value.apply(trx)
            const saved = await trx('sync_states').first(),
              map = JSON.parse(saved.syncMap)
            expect(map.outputBasket.idMap[incoming.basketId]).toBe(localId)
            expect(map.outputBasket.count).toBe(done ? 0 : count + 1)
            expect(new Date(map.outputBasket.maxUpdated_at).getTime()).toBe(incoming.updated_at.getTime())
            if (done) {
              for (const item of Object.values(map) as Array<{ count: number }>) expect(item.count).toBe(0)
              expect(target.storage.validateDate(saved.when).getTime()).toBe(incoming.updated_at.getTime())
            }
          }
        } finally {
          await trx.rollback()
        }
        expect(await state()).toEqual(before)
      }
    ),
    controls
  )
}, 30000)
test('generated changed destination user refuses its original prepared header update and preserves the outer transaction', async () => {
  await open()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(name, fc.boolean(), async (suffix, identity) => {
      const trx = await target.writer.transaction()
      try {
        const { value } = await checkpoint(trx, 0, false)
        await trx('users')
          .where({ userId: 7 })
          .update(identity ? { identityKey: 'changed-' + suffix } : { activeStorage: 'changed-' + suffix })
        const changed = await trx('users').first()
        await value.assert(trx)
        await expect(value.apply(trx)).rejects.toThrow('checkpoint differs')
        expect(await trx('users').first()).toEqual(changed)
        expect(await trx('sync_states')).toEqual([])
        await expect(value.apply(trx)).rejects.toThrow('already consumed')
      } finally {
        await trx.rollback()
      }
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 30000)
test('generated cancellation after real preparation consumes apply authority and leaves durable checkpoint effects unchanged', async () => {
  await open()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(name, fc.boolean(), async (message, prior) => {
      const trx = await target.writer.transaction()
      try {
        if (prior) await insertSource(trx, header.sourceStorage.storageName)
        const controller = new AbortController(),
          { value } = await checkpoint(trx, 0, false, budget(controller.signal)),
          rows = await trx('sync_states')
        const reason = new Error(message)
        controller.abort(reason)
        await expect(value.assert(trx)).rejects.toBe(reason)
        await expect(value.apply(trx)).rejects.toBe(reason)
        expect(await trx('sync_states')).toEqual(rows)
        await expect(value.apply(trx)).rejects.toThrow('already consumed')
      } finally {
        await trx.rollback()
      }
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 30000)

test('generated original small decoded budgets refuse existing checkpoints without durable effects or writable-phase leaks', async () => {
  await open()
  const before = await state()
  await fc.assert(
    fc.asyncProperty(name, fc.integer({ min: 32768, max: 65536 }), async (oldName, maximum) => {
      const trx = await target.writer.transaction()
      try {
        await insertSource(trx, oldName)
        const original = await trx('sync_states').orderBy('syncStateId'),
          allowance: Brc38ImportDecodedBudget = { maximum, remaining: maximum }
        await expect(checkpoint(trx, 0, false, allowance)).rejects.toThrow('allocation budget')
        expect(allowance.remaining).toBeGreaterThanOrEqual(0)
        expect(allowance.remaining).toBeLessThanOrEqual(maximum)
        expect(await trx('sync_states').orderBy('syncStateId')).toEqual(original)
        expect(await trx('brc38_import_ids')).toEqual([])
        expect((await trx.raw('PRAGMA query_only'))[0].query_only).toBe(0)
      } finally {
        await trx.rollback()
      }
      expect(await state()).toEqual(before)
    }),
    controls
  )
}, 30000)
