import * as mod from '../../mod.js'

describe('@bsv/templates 2.0.0 public surface', () => {
  it('exports the BRC-162 codec and strict CBOR', () => {
    for (const name of [
      'Bsv21Binary',
      'Bsv21BinaryError',
      'BSV21_MAX_AMOUNT',
      'encodeAmountChunk',
      'decodeAmountChunk',
      'tokenIdToString',
      'tokenIdFromString',
      'isTokenShaped',
      'encodeStrictCbor',
      'decodeStrictCbor',
      'tryDecodeStrictCbor',
      'StrictCborError',
      'STRICT_CBOR_MAX_BYTES',
      'STRICT_CBOR_MAX_DEPTH'
    ]) {
      expect(name in mod).toBe(true)
    }
  })

  it('no longer exports the Mandala templates', () => {
    for (const name of ['MandalaToken', 'MandalaAdmin', 'ADMIN_PROTOCOL']) {
      expect(name in mod).toBe(false)
    }
  })

  it('keeps the other templates', () => {
    for (const name of [
      'Bsv21Token',
      'DstasToken',
      'MultiPushDrop',
      'OpReturn',
      'P2MSKH',
      'R1K1Wallet',
      'StasToken'
    ]) {
      expect(name in mod).toBe(true)
    }
  })
})
