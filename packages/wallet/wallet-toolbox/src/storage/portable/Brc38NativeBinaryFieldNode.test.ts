import type { Knex } from 'knex'
import { writeBrc38NativeBinaryField } from './Brc38NativeBinaryFieldNode'

const field = {
  field: 'rawTx',
  encoding: 'base64' as const,
  bytes: 0,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
}

// These are authority-refusal cases. They do not substitute a fake driver or
// transaction for actual positive native/component/large-field qualification.
test.each([0, 3])('copied slot%s transaction properties cannot reserve or realize a field', async slot => {
  const sql = jest.fn(async () => undefined)
  const counterfeit = Object.assign(() => undefined, {
    isTransaction: true,
    client: { config: { client: 'better-sqlite3', nativeSlot: slot } },
    raw: sql,
    isCompleted: () => false
  })
  await expect(
    writeBrc38NativeBinaryField(counterfeit as unknown as Knex.Transaction, {
      table: 'transactions',
      sourceIndex: 0,
      destinationRowId: 1,
      field,
      expiresAt: Date.now() + 1000
    })
  ).rejects.toThrow('authenticated published-profile transaction')
  expect(sql).not.toHaveBeenCalled()
})
