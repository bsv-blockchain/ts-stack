import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { knex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { previewDestinationFixture, previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import { captureBrc38KnexDestinationFence } from './Brc38KnexDestinationFence'
import { brc38ImportDestinationDigest } from './Brc38PrivateImportJournalNode'
import { brc38CopiedImportDestinationDigest } from './Brc38CopiedImportDestinationNode'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'

test('a real copied SQLite postimage retains its original journal identity and detects later primary writes', async () => {
  const target = await previewDestinationFixture()
  let staged: Awaited<ReturnType<typeof previewPrivateFixture>> | undefined,
    copied: StorageKnex | undefined,
    database: Knex | undefined
  try {
    staged = await previewPrivateFixture()
    const original = await previewBrc38PrivateImport(
        staged.value.reservation.store,
        target.storage,
        'merge',
        previewReceiptPolicy
      ),
      admission: Brc38ImportJournalAdmission = {
        scope: {
          importId: randomUUID(),
          bindingSha256: original.bindingSha256,
          archiveSha256: original.archiveSha256,
          userId: 7
        },
        previewId: original.previewId,
        originalLimitsJson: staged.value.reservation.store.binding!.limitsJson,
        expiresAt: original.expiresAt,
        initialDestinationSha256: brc38ImportDestinationDigest(original.target),
        totalRows: 1,
        maximumStepRows: 128,
        maximumStepBytes: 65536,
        maximumMappedIds: 1000,
        maximumJournalLogicalBytes: 516096
      }
    const { user } = await target.storage.findOrInsertUser(original.target.identityKey)
    const postimage = await captureBrc38KnexDestinationFence(target.storage, original.target, previewReceiptPolicy),
      expected = brc38ImportDestinationDigest(postimage),
      filename = join(target.directory, 'recovery-copy.sqlite')
    await target.k.raw('VACUUM INTO ?', [filename])
    database = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    await database.raw('PRAGMA journal_mode=WAL')
    copied = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: database })
    await copied.makeAvailable()
    const actual = await captureBrc38KnexDestinationFence(copied, original.target, previewReceiptPolicy)
    expect(actual.backendSha256).not.toBe(postimage.backendSha256)
    expect({ ...actual, backendSha256: postimage.backendSha256 }).toEqual(postimage)
    expect(brc38ImportDestinationDigest(actual)).not.toBe(expected)
    expect(brc38CopiedImportDestinationDigest(actual, original, admission)).toBe(expected)

    for (const changed of [
      { ...admission, previewId: randomUUID() },
      { ...admission, expiresAt: admission.expiresAt + 1 },
      { ...admission, initialDestinationSha256: '0'.repeat(64) },
      { ...admission, scope: { ...admission.scope, bindingSha256: '0'.repeat(64) } },
      { ...admission, scope: { ...admission.scope, archiveSha256: '0'.repeat(64) } }
    ])
      expect(() => brc38CopiedImportDestinationDigest(actual, original, changed)).toThrow('original admitted preview')

    await database('users').where({ userId: user.userId }).update({ activeStorage: 'another primary' })
    await database('users').where({ userId: user.userId }).update({ activeStorage: user.activeStorage })
    const changed = await captureBrc38KnexDestinationFence(copied, original.target, previewReceiptPolicy)
    expect(changed.activeStorage).toBe(actual.activeStorage)
    expect(changed.primaryEpoch).not.toBe(actual.primaryEpoch)
    expect(brc38CopiedImportDestinationDigest(changed, original, admission)).not.toBe(expected)
    expect(await captureBrc38KnexDestinationFence(target.storage, original.target, previewReceiptPolicy)).toEqual(
      postimage
    )
  } finally {
    if (copied !== undefined) await copied.destroy()
    else await database?.destroy()
    await staged?.close()
    await target.close()
  }
})
