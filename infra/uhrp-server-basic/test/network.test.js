const { uhrpNetwork } = require('../out/src/utils/network.js')

describe('uhrpNetwork', () => {
  it('maps TTN to the TTN wallet chain and isolated overlay preset', () => {
    expect(uhrpNetwork('ttn')).toEqual({
      chain: 'ttn',
      lookupPreset: 'teratestnet'
    })
  })

  it('rejects unknown networks', () => {
    expect(() => uhrpNetwork('staging')).toThrow('Unsupported BSV_NETWORK')
  })
})
