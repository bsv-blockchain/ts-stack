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
      'StrictCborLink',
      'STRICT_CBOR_MAX_DEPTH'
    ]) {
      expect(name in mod).toBe(true)
    }
  })

  it('exports the 1Color template', () => {
    expect(typeof mod.OneColor.decode).toBe('function')
    expect(mod.OneColorError).toBe(mod.Bsv21BinaryError)
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

  it('exports the 1Color attribute reader and the 36-byte-aware id helpers', () => {
    for (const name of [
      'isProfileId',
      'readOneColorAttributes',
      'reqMatchesDeploy',
      'needsEmptyPayloadMarker',
      'oneColorTokenIdFromString',
      'oneColorTokenIdToString'
    ])
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function')
    expect(typeof mod.OneColor.lockRemainder).toBe('function')
    const id = `${'ab'.repeat(31)}cd_258`
    expect(mod.oneColorTokenIdFromString(id)).toEqual(mod.OneColor.tokenIdFromString(id))
    expect(mod.oneColorTokenIdToString(mod.oneColorTokenIdFromString(id))).toBe(id)
    expect(() => mod.tokenIdFromString(id)).toThrow('<64 lowercase hex>_0') // the old name stays 32-byte only
  })
})
