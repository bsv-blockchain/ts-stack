import { Transaction, MerklePath } from '@bsv/sdk'
import { txOrdering } from '../ordering.js'

describe('txOrdering', () => {
  it('returns sentinel for an unconfirmed tx (no merkle path)', () => {
    const tx = new Transaction()
    expect(txOrdering(tx)).toEqual({ height: Number.MAX_SAFE_INTEGER, offset: 0 })
  })

  it('reads height and this txid leaf offset from the merkle path', () => {
    const tx = new Transaction()
    const txid = tx.id('hex')
    tx.merklePath = new MerklePath(840000, [[{ offset: 7, hash: txid, txid: true }]])
    expect(txOrdering(tx)).toEqual({ height: 840000, offset: 7 })
  })
})
