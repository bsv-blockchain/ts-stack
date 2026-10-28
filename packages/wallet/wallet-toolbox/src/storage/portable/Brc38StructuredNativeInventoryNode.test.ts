import { dirname } from 'node:path'
import { readdir } from 'node:fs/promises'
import { importJournalFixture } from './Brc38ImportJournalFixture'
import { hasBrc38SqlTextSchema } from './Brc38SqlTextStaging'
import { hasBrc38SqlStructuredSchema } from './Brc38SqlStructuredStaging'
import { hasBrc38SqlCanonicalStructuredSchema } from './Brc38SqlCanonicalStructuredStaging'
import {
  inspectBrc38PrivateStructuredNativeInventory,
  inspectBrc38ReadyPublishedStructuredNativeInventory,
  inspectBrc38PublishedCopyStructuredInventory
} from './Brc38StructuredNativeInventoryNode'

test('real legacy SQLite cannot impersonate any complete private/native/copy structured inventory actor', async () => {
  const fixture = await importJournalFixture()
  try {
    const parent = dirname(fixture.directory),
      expiresAt = fixture.admission.expiresAt,
      policy = {
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
      },
      before = await fixture.k('native_import_rows').select('*'),
      beforeFiles = await readdir(fixture.directory)
    await fixture.k.transaction(async trx => {
      for (const inspect of [
        inspectBrc38PrivateStructuredNativeInventory,
        inspectBrc38ReadyPublishedStructuredNativeInventory,
        inspectBrc38PublishedCopyStructuredInventory
      ])
        await expect(inspect(trx, fixture.admission, policy)).rejects.toThrow()
    })
    expect(await fixture.k('native_import_rows').select('*')).toEqual(before)
    expect(await readdir(fixture.directory)).toEqual(beforeFiles)
  } finally {
    await fixture.close()
  }
})

test.each([
  ['private_text_fields', 'private_text_chunks', hasBrc38SqlTextSchema],
  ['private_structured_fields', 'private_structured_chunks', hasBrc38SqlStructuredSchema],
  ['private_canonical_structured_fields', 'private_canonical_structured_chunks', hasBrc38SqlCanonicalStructuredSchema]
] as const)(
  'an empty altered or partial %s family cannot bypass its exact schema check',
  async (metadata, chunks, inspect) => {
    const fixture = await importJournalFixture()
    try {
      expect(await inspect(fixture.k)).toBe(false)
      await fixture.k.raw('CREATE TABLE ?? (field TEXT)', [metadata])
      await expect(inspect(fixture.k)).rejects.toThrow('content or coordinate differs')
      await fixture.k.raw('CREATE TABLE ?? (field TEXT)', [chunks])
      await expect(inspect(fixture.k)).rejects.toThrow('content or coordinate differs')
      expect(await fixture.k(metadata).count({ count: '*' }).first()).toEqual({ count: 0 })
      expect(await fixture.k(chunks).count({ count: '*' }).first()).toEqual({ count: 0 })
    } finally {
      await fixture.close()
    }
  }
)
