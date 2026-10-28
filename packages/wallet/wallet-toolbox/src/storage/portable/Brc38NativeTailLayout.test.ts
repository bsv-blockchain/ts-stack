import { brc38NativeTailLayout } from './Brc38NativeTailLayout'

test('retains exact column/default/foreign/unique/check definitions while moving every binary to the tail', () => {
  const sql =
      "CREATE TABLE `transactions` (`transactionId` integer PRIMARY KEY AUTOINCREMENT, `rawTx` blob, `userId` integer NOT NULL, `inputBEEF` blob, `note` text DEFAULT 'a,b''c', foreign key(`userId`) references `users`(`userId`), check (`userId` >= 0))",
    result = brc38NativeTailLayout(
      sql,
      'transactions',
      'brc38_tail_transactions',
      ['transactionId', 'rawTx', 'userId', 'inputBEEF', 'note'],
      ['rawTx', 'inputBEEF']
    )
  expect(result).toBe(
    "CREATE TABLE \"brc38_tail_transactions\" (`transactionId` integer PRIMARY KEY AUTOINCREMENT, `userId` integer NOT NULL, `note` text DEFAULT 'a,b''c', `rawTx` blob, `inputBEEF` blob, foreign key(`userId`) references `users`(`userId`), check (`userId` >= 0))"
  )
})
test.each([
  'CREATE TABLE outputs (id integer, lockingScript blob);',
  'CREATE TABLE outputs (id integer, lockingScript blob) WITHOUT ROWID',
  'CREATE TABLE outputs (id integer, lockingScript blob, surprise text)',
  'CREATE TABLE outputs (id integer, id text, lockingScript blob)',
  "CREATE TABLE outputs (id integer, lockingScript blob, CHECK ('unclosed))",
  'CREATE TABLE outputs (id integer, lockingScript blob /* hidden */)'
])('refuses ambiguous or extra DDL %s before native schema mutation', sql => {
  expect(() =>
    brc38NativeTailLayout(sql, 'outputs', 'brc38_tail_outputs', ['id', 'lockingScript'], ['lockingScript'])
  ).toThrow()
})
test('rejects caller SQL identifiers and missing/duplicate binary columns before transformation', () => {
  const sql = 'CREATE TABLE outputs (id integer, lockingScript blob)'
  expect(() => brc38NativeTailLayout(sql, 'outputs', 'bad;drop', ['id', 'lockingScript'], ['lockingScript'])).toThrow()
  expect(() => brc38NativeTailLayout(sql, 'outputs', 'temporary', ['id', 'lockingScript'], ['rawTx'])).toThrow()
  expect(() =>
    brc38NativeTailLayout(sql, 'outputs', 'temporary', ['id', 'lockingScript'], ['lockingScript', 'lockingScript'])
  ).toThrow()
})
