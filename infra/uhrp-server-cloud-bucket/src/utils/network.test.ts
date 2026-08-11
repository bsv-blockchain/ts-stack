import { uhrpNetwork } from './network'
import { describe, expect, it } from '@jest/globals'

describe('uhrpNetwork', () => {
  it('maps TTN to the TTN wallet chain and isolated overlay preset', () => {
    expect(uhrpNetwork('teratestnet')).toEqual({
      chain: 'ttn',
      lookupPreset: 'teratestnet'
    })
  })

  it('rejects unknown networks', () => {
    expect(() => uhrpNetwork('staging')).toThrow('Unsupported BSV_NETWORK')
  })
})
