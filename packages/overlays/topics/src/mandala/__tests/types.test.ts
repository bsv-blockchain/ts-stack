import {
  InMemoryScreeningProvider, encodeLinkagePayload, decodeLinkagePayload, MandalaLinkagePayload
} from '../types.js'

describe('mandala types', () => {
  it('screens listed identity keys', async () => {
    const p = new InMemoryScreeningProvider(['02aa'])
    expect(await p.isSanctioned('02aa')).toBe(true)
    expect(await p.isSanctioned('02bb')).toBe(false)
  })

  it('round-trips a linkage payload through offChainValues bytes', () => {
    const payload: MandalaLinkagePayload = {
      inputs: [],
      outputs: [{ index: 0, linkage: {
        prover: '02aa', verifier: '02bb', counterparty: '02cc',
        protocolID: [2, 'mandala token'], keyID: 'k1',
        encryptedLinkage: [1, 2, 3], encryptedLinkageProof: [0], proofType: 0
      } }]
    }
    expect(decodeLinkagePayload(encodeLinkagePayload(payload))).toEqual(payload)
  })
})


describe('Mandala payload index validation', () => {
  const decode = (value: unknown) => decodeLinkagePayload(Array.from(new TextEncoder().encode(JSON.stringify(value))))
  test.each([null, false, 1, 'text'])('rejects non-object payload %p', value => {
    expect(() => decode(value)).toThrow('payload must be an object')
  })
  test.each(['inputs', 'outputs', 'admin'])('validates %s indices', key => {
    for (const entries of [null, {}, [null], [{ index: -1 }], [{ index: 0.5 }], [{ index: '0' }], [{ index: 0 }, { index: 0 }]]) {
      expect(() => decode({ inputs: [], outputs: [], [key]: entries })).toThrow()
    }
  })
  test('canonicalizes screening key letter case', async () => {
    expect(await new InMemoryScreeningProvider(['02AB']).isSanctioned('02ab')).toBe(true)
  })
})
