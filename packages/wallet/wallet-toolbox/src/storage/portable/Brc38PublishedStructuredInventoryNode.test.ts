import { importJournalFixture } from './Brc38ImportJournalFixture'
import {
  readBrc38StructuredRestoreResources,
  inspectBrc38PublishedStructuredRestoreInventory
} from './Brc38PublishedStructuredInventoryNode'

test('a real legacy SQLite transaction cannot supply published structured admission or route inventory', async () => {
  const fixture = await importJournalFixture()
  try {
    const before = await fixture.k('native_import_rows').select('*')
    await fixture.k.transaction(async trx => {
      await expect(readBrc38StructuredRestoreResources(trx, fixture.admission)).rejects.toThrow(
        'actual private read-only'
      )
      for (const runtime of ['published-native', 'published-copy'] as const)
        await expect(
          inspectBrc38PublishedStructuredRestoreInventory(trx, fixture.admission, runtime, fixture.admission.expiresAt)
        ).rejects.toThrow('actual private read-only')
    })
    expect(await fixture.k.schema.hasTable('private_native_restore')).toBe(false)
    expect(await fixture.k('native_import_rows').select('*')).toEqual(before)
  } finally {
    await fixture.close()
  }
})
