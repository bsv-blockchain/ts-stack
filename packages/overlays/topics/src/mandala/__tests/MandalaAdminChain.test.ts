import { jest } from '@jest/globals'
import { MandalaTopicManager, type MandalaTopicManagerDeps } from '../MandalaTopicManager.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import type { MandalaActionDetails } from '@bsv/templates'

const assetId = `${'a'.repeat(64)}.0`
const prior = `${'b'.repeat(64)}.1`
const details: MandalaActionDetails = { kind: 'pause', assetId, priorOutpoint: prior }

function manager(verify?: MandalaTopicManagerDeps['stateStore']['isAdminOutpoint']) {
  const stateStore = {
    getAssetState: async () => defaultAssetState(assetId),
    getTokenRow: async () => null,
    ...(verify ? { isAdminOutpoint: verify } : {})
  }
  const subject = new MandalaTopicManager({
    stateStore,
    verifierWallet: {} as MandalaTopicManagerDeps['verifierWallet'],
    adminWallet: {} as MandalaTopicManagerDeps['adminWallet'],
    screeningProvider: { isSanctioned: async () => false },
    adminProtocolID: [2, 'mandala admin']
  })
  return { subject, stateStore }
}

const anchored = (subject: MandalaTopicManager, action = details, admitted = new Set([prior])) =>
  (subject as any).priorAnchored(action, admitted) as Promise<boolean>

describe('Mandala admin authority contract', () => {
  test('requires a state verifier for non-genesis admission', async () => {
    await expect(anchored(manager().subject)).rejects.toThrow('requires stateStore.isAdminOutpoint')
  })

  test('requires both the admitted input and the exact per-asset history entry', async () => {
    const verify = jest.fn(
      async (asset: string, txid: string, index: number) =>
        asset === assetId && `${txid}.${index}` === prior
    )
    const { subject } = manager(verify)
    expect(await anchored(subject)).toBe(true)
    expect(verify).toHaveBeenCalledWith(assetId, 'b'.repeat(64), 1)
    expect(await anchored(subject, details, new Set())).toBe(false)
    expect(await anchored(subject, { ...details, assetId: `${'c'.repeat(64)}.0` })).toBe(false)
  })

  test('preserves a class-style store method receiver', async () => {
    const { subject, stateStore } = manager()
    Object.assign(stateStore, {
      registered: prior,
      async isAdminOutpoint(
        this: { registered: string },
        _asset: string,
        txid: string,
        index: number
      ) {
        return this.registered === `${txid}.${index}`
      }
    })
    expect(await anchored(subject)).toBe(true)
  })

  test.each([undefined, '', 'not-an-outpoint', `${'b'.repeat(64)}.-1`, `${'b'.repeat(64)}.1.5`])(
    'rejects missing or unregistered prior %s',
    async priorOutpoint => {
      expect(await anchored(manager(async () => true).subject, { ...details, priorOutpoint })).toBe(
        false
      )
    }
  )

  test('rejects malformed admitted outpoints and absent asset identifiers', async () => {
    const { subject } = manager(async () => true)
    for (const priorOutpoint of ['invalid', '.0', 'source.-1', 'source.NaN']) {
      const admitted = new Set([priorOutpoint])
      expect(await anchored(subject, { ...details, priorOutpoint }, admitted)).toBe(false)
    }
    expect(await anchored(subject, { ...details, assetId: '' })).toBe(false)
    expect(await anchored(subject, { ...details, assetId: undefined })).toBe(false)
  })

  test('propagates unavailable history instead of treating it as authority', async () => {
    await expect(
      anchored(
        manager(async () => {
          throw new Error('history unavailable')
        }).subject
      )
    ).rejects.toThrow('history unavailable')
    expect(await anchored(manager(async () => false).subject)).toBe(false)
  })

  test('registration has no prior but cannot claim an existing asset identifier', async () => {
    const { subject } = manager()
    expect(await anchored(subject, { kind: 'register' }, new Set())).toBe(true)
    expect(await anchored(subject, { kind: 'register', assetId: '' }, new Set())).toBe(true)
    expect(await anchored(subject, { kind: 'register', assetId }, new Set())).toBe(false)
  })

  test('rejects duplicate or invalid engine input indices before conservation', () => {
    const { subject } = manager()
    const tx = { inputs: [{ sourceTXID: 'b'.repeat(64), sourceOutputIndex: 1 }] }
    for (const indices of [[0, 0], [-1], [0.5], [1], [NaN]]) {
      expect(() => (subject as any).admittedInputOutpoints(tx, indices)).toThrow(
        'unique valid input indices'
      )
    }
    expect((subject as any).admittedInputOutpoints(tx, [0])).toEqual(new Set([prior]))
  })
})
