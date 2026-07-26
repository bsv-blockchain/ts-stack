import { MandalaAdmin, MandalaActionDetails } from '../MandalaAdmin.js'

describe('MandalaAdmin new action kinds', () => {
  it('commitment is deterministic and field-order independent for new kinds', () => {
    const a: MandalaActionDetails = {
      kind: 'reissue',
      assetId: 'x.0',
      outpoint: 'y.1',
      amount: 5,
      recipient: '02ab',
      bankRef: 'BR-1',
      priorOutpoint: 'z.0'
    }
    const b: MandalaActionDetails = {
      priorOutpoint: 'z.0',
      bankRef: 'BR-1',
      recipient: '02ab',
      amount: 5,
      outpoint: 'y.1',
      assetId: 'x.0',
      kind: 'reissue'
    }
    expect(MandalaAdmin.commitment(a)).toBe(MandalaAdmin.commitment(b))
  })

  it('distinct kinds and params yield distinct commitments', () => {
    const pause: MandalaActionDetails = { kind: 'pause', assetId: 'x.0', priorOutpoint: 'z.0' }
    const unpause: MandalaActionDetails = { kind: 'unpause', assetId: 'x.0', priorOutpoint: 'z.0' }
    const blockA: MandalaActionDetails = {
      kind: 'blockIdentity',
      assetId: 'x.0',
      identityKey: '02aa',
      priorOutpoint: 'z.0'
    }
    const blockB: MandalaActionDetails = {
      kind: 'blockIdentity',
      assetId: 'x.0',
      identityKey: '02bb',
      priorOutpoint: 'z.0'
    }
    const set = new Set([pause, unpause, blockA, blockB].map(d => MandalaAdmin.commitment(d)))
    expect(set.size).toBe(4)
  })

  it('bankRef participates in the commitment (dropping it changes the key)', () => {
    const withRef: MandalaActionDetails = {
      kind: 'reissue',
      assetId: 'x.0',
      outpoint: 'y.1',
      amount: 5,
      recipient: '02ab',
      bankRef: 'BR-1',
      priorOutpoint: 'z.0'
    }
    const withoutRef: MandalaActionDetails = {
      kind: 'reissue',
      assetId: 'x.0',
      outpoint: 'y.1',
      amount: 5,
      recipient: '02ab',
      priorOutpoint: 'z.0'
    }
    expect(MandalaAdmin.commitment(withRef)).not.toBe(MandalaAdmin.commitment(withoutRef))
  })
})
