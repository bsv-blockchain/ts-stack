import type { Knex } from 'knex'
import { hashBrc38NativePackedChunkWindows } from './Brc38NativePackedHashWindowNode'
import { hashBrc38NativePackedVersion } from './Brc38NativePackedFieldsNode'
import { hashBrc38NativePackedTextVersion } from './Brc38NativePackedTextFieldsNode'

// Authored UNRUN. Copied actor/SQL refusal only; genuine native hashing and
// physical read budgets require the separate fresh packaged engine case.
test('window limits and copied native flags cannot enroll a chunk hashing actor', async () => {
  const sql = jest.fn(() => {
      throw new Error('Counterfeit SQL must not run')
    }),
    k = Object.assign(sql, {
      isTransaction: true,
      client: { config: { client: 'OwnedNativeSqliteClient' } }
    }) as unknown as Knex.Transaction
  for (const width of [0, 1, 17, 4096, 65537, NaN]) {
    await expect(
      hashBrc38NativePackedChunkWindows(k, 'brc38_native_binary_chunks', 'a'.repeat(64), 64, width, () => {})
    ).rejects.toThrow('authenticated published-profile')
    await expect(hashBrc38NativePackedVersion(k, 'a'.repeat(64), 64, () => {}, width)).rejects.toThrow(
      'authenticated published-profile'
    )
    await expect(hashBrc38NativePackedTextVersion(k, 'a'.repeat(64), 64, () => {}, width)).rejects.toThrow(
      'authenticated published-profile'
    )
  }
  expect(sql).not.toHaveBeenCalled()
})
