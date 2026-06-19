import {
  encodeScriptNum, decodeScriptNum, encodeAssetId, decodeAssetId, MARKER
} from '../mandala-encoding'

describe('mandala-encoding', () => {
  it('round-trips small and large script numbers', () => {
    for (const n of [0, 1, 16, 127, 128, 255, 256, 1000, 0x7fffffff]) {
      expect(decodeScriptNum(encodeScriptNum(n))).toBe(n)
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

  it('exposes the ! marker', () => {
    expect(MARKER).toBe(0x21)
  })
})
