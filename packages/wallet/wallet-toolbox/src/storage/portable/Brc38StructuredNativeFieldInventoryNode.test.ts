import { dirname } from 'node:path'
import { readdir } from 'node:fs/promises'
import { importJournalFixture } from './Brc38ImportJournalFixture'
import { inspectBrc38StructuredNativeField } from './Brc38StructuredNativeFieldInventoryNode'

test('a real legacy SQLite transaction cannot supply an independent native structured postimage proof', async () => {
  const fixture = await importJournalFixture()
  try {
    const expiresAt = fixture.admission.expiresAt,
      parent = dirname(fixture.directory),
      before = await fixture.k('native_import_rows').select('*'),
      beforeFiles = await readdir(fixture.directory)
    await fixture.k.transaction(async trx => {
      await expect(
        inspectBrc38StructuredNativeField(
          trx,
          fixture.admission,
          { table: 'provenTxReqs', field: 'notify', rowId: 1, sourceIndex: 0 },
          {
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
              expiresAt
            },
            inspectionExpiresAt: expiresAt,
            maximumCombinedTemporaryBytes: 3145728
          }
        )
      ).rejects.toThrow('actual private read-only')
    })
    expect(await fixture.k('native_import_rows').select('*')).toEqual(before)
    expect(await readdir(fixture.directory)).toEqual(beforeFiles)
  } finally {
    await fixture.close()
  }
})
