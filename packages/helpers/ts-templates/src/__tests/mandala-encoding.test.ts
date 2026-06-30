import {
  createMinimallyEncodedScriptChunk, encodeScriptNum, decodeScriptNum,
  decodeScriptNumChunk, encodeAssetId, decodeAssetId
} from '../mandala-encoding'

describe('mandala-encoding', () => {
  it('round-trips small and large script numbers', () => {
    for (const n of [0, 1, 16, 127, 128, 255, 256, 1000, 0x7fffffff]) {
      expect(decodeScriptNum(encodeScriptNum(n))).toBe(n)
    }
  })

  it('decodeScriptNumChunk reads both OP_N opcodes and data pushes', () => {
    // -1, 0 and 1..16 collapse to opcodes with no data; decodeScriptNumChunk
    // must recover them, and still read larger data-push amounts.
    for (const n of [-1, 0, 1, 2, 15, 16, 17, 100, 1000, 0x7fffffff]) {
      const chunk = createMinimallyEncodedScriptChunk(encodeScriptNum(n))
      expect(decodeScriptNumChunk(chunk)).toBe(n)
    }
  })

  it('encodes zero as an empty array', () => {
    expect(encodeScriptNum(0)).toEqual([])
  })

  it('round-trips an assetId outpoint string', () => {
    const txid = 'a'.repeat(64)
    const assetId = `${txid}.3`
    const bytes = encodeAssetId(assetId)
    expect(bytes.length).toBe(36)
    expect(decodeAssetId(bytes)).toBe(assetId)
  })

  it('round-trips an assetId with a high-bit vout (>= 2^31)', () => {
    const assetId = `${'a'.repeat(64)}.4294967295`
    expect(decodeAssetId(encodeAssetId(assetId))).toBe(assetId)
  })

  it('encodes the txid in outpoint (internal/reversed) byte order + LE vout', () => {
    // Distinct first/last bytes so reversal is observable.
    const txid = '11' + 'aa'.repeat(30) + '22' // 32 bytes: 0x11 .. 0x22
    const bytes = encodeAssetId(`${txid}.1`)
    expect(bytes[0]).toBe(0x22) // display last byte → first on-chain (reversed)
    expect(bytes[31]).toBe(0x11) // display first byte → last on-chain
    expect(bytes.slice(32)).toEqual([1, 0, 0, 0]) // vout little-endian
  })
})
