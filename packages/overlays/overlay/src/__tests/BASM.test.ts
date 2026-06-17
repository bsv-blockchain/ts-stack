import { computeBasmRoot, computeTac } from '../BASM'

const ZERO = '0000000000000000000000000000000000000000000000000000000000000000'
const TXID_1 = '0101010101010101010101010101010101010101010101010101010101010101'
const TXID_2 = '0202020202020202020202020202020202020202020202020202020202020202'
const TXID_3 = '0303030303030303030303030303030303030303030303030303030303030303'
const BLOCK_HASH = '0404040404040404040404040404040404040404040404040404040404040404'

describe('BRC-136 BASM helpers', () => {
  it('computes the empty BASM root as 32 zero bytes', () => {
    expect(computeBasmRoot([])).toBe(ZERO)
  })

  it('uses the single admitted txid as the BASM root', () => {
    expect(computeBasmRoot([TXID_1])).toBe(TXID_1)
  })

  it('hashes two txids in internal byte order and returns display hex', () => {
    expect(computeBasmRoot([TXID_1, TXID_2])).toBe(
      'b4100303b9e99ada4b479b0bb93d9b549cb057a1c4be08896bc982debe20ce39'
    )
  })

  it('duplicates the odd leaf in multi-layer BASM roots', () => {
    expect(computeBasmRoot([TXID_1, TXID_2, TXID_3])).toBe(
      'acbd47d5022a6c5e954ad677df8ec221c893f871889826df53f0f1ad3f023e22'
    )
  })

  it('orders admitted refs by blockIndex instead of txid', () => {
    const root = computeBasmRoot([
      { txid: TXID_2, blockIndex: 20 },
      { txid: TXID_1, blockIndex: 10 }
    ])
    expect(root).toBe('b4100303b9e99ada4b479b0bb93d9b549cb057a1c4be08896bc982debe20ce39')
  })

  it('chains TAC in internal byte order', () => {
    const root = computeBasmRoot([TXID_1, TXID_2, TXID_3])
    expect(computeTac(ZERO, BLOCK_HASH, root)).toBe(
      'd0d3e770802c7c28ca1da59cc92263d59425f00e48d421ffebb02497b4702307'
    )
  })
})
