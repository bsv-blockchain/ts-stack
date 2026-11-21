import { randomUUID } from 'node:crypto'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport, decodeBrc38PrivateImportPreview } from './Brc38PrivateImportPreviewNode'
import { installBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'
import { type Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import {
  brc38ImportDestinationDigest,
  prepareBrc38PrivateImportJournal,
  commitBrc38PrivateImportPage
} from './Brc38PrivateImportJournalNode'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'

describe('accepted signed native target profile identity', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
    staged: Awaited<ReturnType<typeof previewPrivateFixture>>
  beforeEach(async () => {
    target = await previewDestinationFixture()
    staged = await previewPrivateFixture()
  })
  afterEach(async () => {
    try {
      await staged?.close()
    } finally {
      await target?.close()
    }
  })
  test.each([-7, -Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER])(
    'existing StorageKnex profile %s retains actual identity, primary, same-owner checkpoint and native mapping',
    async userId => {
      const store = staged.value.reservation.store,
        now = new Date('2026-01-02T03:04:05.006Z'),
        identityKey = store.binding?.binding.identityKey
      if (identityKey === undefined) throw new Error('Fixture binding missing')
      // The existing storage API is the independent accepted-value oracle.
      const insertedId = userId === 0 ? -7 : userId
      expect(
        await target.storage.insertUser({
          userId: insertedId,
          identityKey,
          activeStorage: '',
          created_at: now,
          updated_at: now
        })
      ).toBe(insertedId)
      // Zero allocates on insert; the existing update API can retain a zero
      // native key in legacy databases, and lookup preserves that identity.
      if (userId === 0) await target.storage.updateUser(insertedId, { userId })
      expect((await target.storage.findUsers({ partial: { identityKey } }))[0].userId).toBe(userId)
      await target.k.transaction(async trx => await installBrc38ImportJournalSchema(trx))
      const preview = await previewBrc38PrivateImport(store, target.storage, 'merge', policy),
        binding = store.binding,
        metadata = await store.withAuthenticatedImportView(async (_json, value) => value)
      if (binding === undefined) throw new Error('Fixture binding missing')
      expect(preview.target).toMatchObject({ userId, activeStorage: '', primaryEpoch: '0' })
      await store.withAuthenticatedImportView(async json => {
        expect(decodeBrc38PrivateImportPreview(store, json)).toEqual(preview)
      })
      const admission: Brc38ImportJournalAdmission = {
        scope: {
          importId: randomUUID(),
          bindingSha256: binding.digest,
          archiveSha256: binding.binding.archiveSha256,
          userId
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
      await prepareBrc38PrivateImportJournal(store, target.storage, {
        admission,
        receiptPolicy: policy
      })
      const first = await commitBrc38PrivateImportPage(store, target.storage, {
          admission,
          receiptPolicy: policy,
          fromRow: 0,
          async apply(trx, data) {
            if (data.kind !== 'header') throw new Error('Prepared header missing')
            expect(data.user.identityKey).toBe(identityKey)
            await target.storage.updateUser(userId, { updated_at: new Date(now.getTime() + 1) }, trx)
          }
        }),
        replay = jest.fn()
      expect(
        await commitBrc38PrivateImportPage(store, target.storage, {
          admission,
          receiptPolicy: policy,
          fromRow: 0,
          apply: replay
        })
      ).toEqual(first)
      expect(replay).not.toHaveBeenCalled()
      const proof = await commitBrc38PrivateImportPage(store, target.storage, {
        admission,
        receiptPolicy: policy,
        fromRow: 1,
        async apply(trx, data, references) {
          if (data.kind !== 'table' || data.table !== 'provenTxs') throw new Error('Prepared proof missing')
          const ids = await loadBrc38ImportIdMap(trx, admission.scope, references)
          for (const row of data.rows)
            ids.map.provenTx.idMap[row.provenTxId] = await target.storage.insertProvenTx({ ...row, provenTxId: 0 }, trx)
          await ids.persist()
        }
      })
      expect(proof).toMatchObject({ nextRow: 2, mappedIds: 1 })
      expect(
        await target.writer('brc38_import_journal').where({ importId: admission.scope.importId }).first('userId')
      ).toEqual({ userId })
      expect(await target.writer('brc38_import_ids').where({ userId })).toHaveLength(1)
      expect((await target.storage.findUsers({ partial: { identityKey } }))[0]).toMatchObject({
        userId,
        activeStorage: ''
      })
    }
  )
})
