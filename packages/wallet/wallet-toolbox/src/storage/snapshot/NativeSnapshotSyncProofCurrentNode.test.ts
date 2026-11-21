import { nativeSnapshotSyncProofRow } from './NativeSnapshotSyncProofCurrentNode'

// Authored only. Execute on the complete immutable program in its qualified
// native controller; this module imports native current-row transport too.
test.each(['AB', 'ab', 'Ab'])('native proof scalar policy copies dates and preserves %s storage identifiers', spelling => {
  const created_at = new Date(1),
    updated_at = new Date(2),
    row = {
      provenTxId: 7,
      created_at,
      updated_at,
      txid: spelling.repeat(32),
      blockHash: 'CD'.repeat(32),
      merkleRoot: 'EF'.repeat(32),
      height: 0,
      index: 0
    },
    proof = nativeSnapshotSyncProofRow(row)
  created_at.setTime(99)
  updated_at.setTime(100)
  expect(proof).toEqual({
    ...row,
    created_at: new Date(1),
    updated_at: new Date(2),
    txid: spelling.repeat(32),
    blockHash: 'CD'.repeat(32),
    merkleRoot: 'EF'.repeat(32)
  })
  expect(Object.isFrozen(proof)).toBe(true)
})
test.each([
  { provenTxId: 0 },
  { height: -1 },
  { index: 0.1 },
  { txid: 'ff' },
  { blockHash: 'gg'.repeat(32) },
  { created_at: new Date(NaN) },
  { rawTx: [] },
  { userId: 1 }
])('native proof form refuses hidden payloads and invalid original scalars %j', changed => {
  expect(() =>
    nativeSnapshotSyncProofRow({
      provenTxId: 7,
      created_at: new Date(1),
      updated_at: new Date(2),
      txid: 'ab'.repeat(32),
      blockHash: 'cd'.repeat(32),
      merkleRoot: 'ef'.repeat(32),
      height: 0,
      index: 0,
      ...changed
    })
  ).toThrow()
})
