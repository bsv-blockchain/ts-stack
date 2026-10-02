import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, type OutputJSONObject } from '@bsv/sdk'
import { address, authorize, change, clock, fixture } from './protected-ledger-fixture.js'
import { alterStorage, restoreHead, restoreRecord } from './protected-ledger-restoration-fixture.js'

function unavailable(work: () => unknown, message: string): void {
  expect(work).toThrow(
    expect.objectContaining({ name: 'OutputProtocolError', code: 'unavailable', message })
  )
}
function populated() {
  const f = fixture()
  f.ledger.commit('0', [change()], clock, authorize)
  return f
}

it.each([
  ['missing', 'DELETE FROM protected_head'],
  ['oversized', "UPDATE protected_head SET envelope=replace(hex(zeroblob(24000)),'0','x')"]
])('classifies a %s restored head as unavailable before disclosure', (_label, sql) => {
  const f = populated()
  alterStorage(f, sql)
  unavailable(() => f.reopen(), 'Protected ledger head is missing or oversized')
  unavailable(
    () => f.ledger.read([address()], clock, authorize),
    'Protected ledger head is missing or oversized'
  )
})

it.each<[string, OutputJSONObject]>([
  ['revision disagreement', { revision: '2' }],
  ['null count', { records: null }],
  ['nonnumeric count', { records: '1' }],
  ['boolean bytes', { reservedBytes: false }],
  ['nonnumeric bytes', { reservedBytes: '128' }],
  ['array completions', { reservedUpdates: [] }],
  ['nonnumeric completions', { reservedUpdates: '4' }]
])('checks semantic head binding after successful custody authentication: %s', (_label, patch) => {
  const f = populated()
  restoreHead(f, head => {
    Object.assign(head, patch)
  })
  unavailable(() => f.reopen(), 'Protected ledger head binding failed')
})

it.each<[string, OutputJSONObject]>([
  ['inventory', { inventory: '00'.repeat(32) }],
  ['records', { records: 2 }],
  ['reserved bytes', { reservedBytes: 129 }],
  ['reserved completions', { reservedUpdates: 5 }]
])('checks each authenticated inventory field independently: %s', (_label, patch) => {
  const f = populated()
  restoreHead(f, head => {
    Object.assign(head, patch)
  })
  unavailable(() => f.reopen(), 'Protected ledger inventory binding failed')
  unavailable(
    () => f.ledger.read([address()], clock, authorize),
    'Protected ledger inventory binding failed'
  )
})

it('rejects a record revision newer than the authenticated global revision', () => {
  const f = populated()
  restoreRecord(f, Buffer.from(canonicalOutputJSON(change().value)), { revision: '2' })
  unavailable(() => f.reopen(), 'Protected ledger inventory binding failed')
})

it('enforces the reserved plaintext bound after successful decryption', () => {
  const f = populated()
  // Declared bytes fit the slot; authenticated plaintext does not. The reader must
  // check plaintext itself instead of trusting this imported header declaration.
  restoreRecord(f, Buffer.from(canonicalOutputJSON({ secret: 'x'.repeat(117) })), { bytes: 128 })
  unavailable(() => f.reopen(), 'Protected ledger plaintext exceeds its bound')
})

it('refuses invalid UTF-8 rather than returning a replacement-character secret', () => {
  const f = populated()
  restoreRecord(
    f,
    Buffer.concat([Buffer.from('{"secret":"'), Buffer.from([255]), Buffer.from('"}')])
  )
  unavailable(() => f.reopen(), 'Invalid protected ledger UTF-8')
})

it('refuses authenticated noncanonical JSON rather than silently normalizing restoration', () => {
  const f = populated()
  restoreRecord(f, Buffer.from('{"secret": "synthetic-material"}'))
  unavailable(() => f.reopen(), 'Noncanonical protected ledger record')
})

it('checks declared UTF-8 bytes against the decrypted value', () => {
  const f = populated()
  const plaintext = Buffer.from(canonicalOutputJSON({ secret: 'é' }))
  restoreRecord(f, plaintext, { bytes: plaintext.length - 1 })
  unavailable(() => f.reopen(), 'Protected ledger record length differs')
})

it('checks record envelope integrity before trying to interpret its plaintext', () => {
  const f = populated()
  alterStorage(f, "UPDATE protected_records SET envelope='{}'")
  unavailable(() => f.reopen(), 'Protected ledger record integrity failed')
  unavailable(
    () => f.ledger.read([address()], clock, authorize),
    'Protected ledger record integrity failed'
  )
})

it('rejects oversized record envelopes even when their inventory digest is authenticated', () => {
  const f = populated()
  restoreRecord(f, Buffer.from('{}'), { envelope: ' '.repeat(5000) })
  unavailable(() => f.reopen(), 'Protected ledger record integrity failed')
})
