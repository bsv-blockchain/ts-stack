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
