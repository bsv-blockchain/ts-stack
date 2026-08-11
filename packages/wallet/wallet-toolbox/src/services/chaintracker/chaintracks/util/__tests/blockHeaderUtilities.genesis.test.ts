import { Chain } from '../../../../../sdk/types'
import {
  blockHash,
  genesisBuffer,
  genesisHeader,
  validateBufferOfHeaders,
  validateGenesisHeader,
  validateHeaderProofOfWork
} from '../blockHeaderUtilities'

describe('ChainTracks genesis headers', () => {
  const expected: Record<Exclude<Chain, 'mock'>, string> = {
    main: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    test: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
    stn: '6b38bdbcd73a19f7889d23e1fa6166a9de71affceca60ca3bb1b28af8135c594',
    ttn: '000000000499eabba0a88f5b3747231c74b9191c1a4a04b2c2ea817976b7776d',
    tstn: '000000005d221c0e023cb56b5682cf094f32cd959958b40bc931e5797cae706c'
  }

  test.each(Object.entries(expected) as Array<[Exclude<Chain, 'mock'>, string]>)(
    '%s uses its exact serialized genesis header',
    (chain, hash) => {
      const bytes = genesisBuffer(chain)
      expect(bytes).toHaveLength(80)
      expect(blockHash(bytes)).toBe(hash)
      expect(genesisHeader(chain).hash).toBe(hash)
      expect(() => validateGenesisHeader(Uint8Array.from(bytes), chain)).not.toThrow()
      expect(() => validateHeaderProofOfWork(genesisHeader(chain))).not.toThrow()
    }
  )

  test('Teranode test and scaling-test networks have distinct genesis headers', () => {
    expect(genesisBuffer('ttn')).not.toEqual(genesisBuffer('test'))
    expect(genesisBuffer('tstn')).not.toEqual(genesisBuffer('test'))
    expect(genesisBuffer('tstn')).not.toEqual(genesisBuffer('ttn'))
  })

  test('rejects a header whose hash exceeds its declared proof-of-work target', () => {
    const header = { ...genesisHeader('main'), bits: 0x03000001 }
    expect(() => validateHeaderProofOfWork(header)).toThrow('Block hash is not less than specified target.')
  })

  test('rejects negative, overflowing, and above-limit compact targets', () => {
    const header = genesisHeader('main')
    expect(() => validateHeaderProofOfWork({ ...header, bits: 0x1d80ffff })).toThrow(
      'Block target encoding is invalid.'
    )
    expect(() => validateHeaderProofOfWork({ ...header, bits: 0x2300ffff })).toThrow(
      'Block target encoding is invalid.'
    )
    expect(() => validateHeaderProofOfWork({ ...header, bits: 0x1d010000 })).toThrow(
      'Block target exceeds the proof-of-work limit.'
    )
  })

  test('limits the historical STN exception to its exact target declaration', () => {
    const header = genesisHeader('stn')
    expect(() => validateHeaderProofOfWork({ ...header, bits: 0x1d00fffe })).toThrow(
      'Block hash is not less than specified target.'
    )
  })

  test('validates proof-of-work while walking a bulk-header buffer', () => {
    const bytes = Uint8Array.from(genesisBuffer('main'))
    expect(() => validateBufferOfHeaders(bytes, '00'.repeat(32))).not.toThrow()
    bytes[72] = 1
    bytes[73] = 0
    bytes[74] = 0
    bytes[75] = 3
    expect(() => validateBufferOfHeaders(bytes, '00'.repeat(32))).toThrow(
      'Block hash is not less than specified target.'
    )
  })
})
