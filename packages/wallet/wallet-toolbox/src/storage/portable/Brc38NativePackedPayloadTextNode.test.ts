import {
  prepareBrc38NativePackedTextWalletWrite,
  prechargeBrc38NativePackedTextWalletWrite
} from './Brc38NativePackedTextWalletNode'

// Independent table/column fixtures, including the original structured family.
const tables = [
  ['transactions', ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix']],
  [
    'outputs',
    [
      'outputDescription',
      'spendingDescription',
      'customInstructions',
      'derivationPrefix',
      'derivationSuffix',
      'type',
      'purpose'
    ]
  ],
  ['commissions', ['keyOffset']],
  ['certificates', ['subject', 'revocationOutpoint', 'signature', 'verifier']],
  ['certificate_fields', ['fieldValue', 'masterKey']],
  ['proven_tx_reqs', ['history', 'notify']],
  ['sync_states', ['syncMap', 'errorLocal', 'errorOther']]
] as const
test.each(tables)(
  'complete bounded %s text preparation preserves independent spelling and owns its bytes',
  (table, fields) => {
    const original: Record<string, unknown> = { untouched: 'ordinary scalar' }
    for (const [index, field] of fields.entries()) original[field] = '\ufeff' + field + ' 😀水\u0000 ' + index
    const expected = { ...original },
      prepared = prepareBrc38NativePackedTextWalletWrite(table, original)
    for (const field of fields) original[field] = 'caller changed'
    expect(prepared.row.untouched).toBe('ordinary scalar')
    expect(prepared.fields.map(value => value.field)).toEqual(fields)
    for (const field of prepared.fields) {
      expect(prepared.row[field.field]).toBe('')
      expect(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(field.bytes)).toBe(expected[field.field])
    }
    for (const field of prepared.fields) field.bytes.fill(0)
  }
)
test('new binary-plus-text tables pay one combined admission before copying payloads', () => {
  const rawTx = new Uint8Array(520000),
    description = 'x'.repeat(520000)
  expect(() => prechargeBrc38NativePackedTextWalletWrite('transactions', { rawTx })).not.toThrow()
  expect(() => prechargeBrc38NativePackedTextWalletWrite('transactions', { description })).not.toThrow()
  expect(() => prepareBrc38NativePackedTextWalletWrite('transactions', { rawTx, description })).toThrow('combined')
})
test('null, omission and empty text remain distinct from each other', () => {
  const prepared = prepareBrc38NativePackedTextWalletWrite('outputs', {
    customInstructions: null,
    outputDescription: ''
  })
  expect(prepared.row.customInstructions).toBeNull()
  expect(Object.hasOwn(prepared.row, 'spendingDescription')).toBe(false)
  expect(prepared.fields.map(field => [field.field, field.bytes.length])).toEqual([['outputDescription', 0]])
})
