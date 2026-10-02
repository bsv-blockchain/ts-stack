/**
 * The package's own entry point, loaded.
 *
 * Every other suite imports the modules directly, so nothing here had ever
 * imported `src/index.ts` and a consumer's view of this package went untested:
 * a name dropped from the barrel, or a circular import between two topics,
 * would have shown up first for whoever installed it.
 */
import * as topics from '../index.js'

describe('the package entry point', () => {
  it('exports the uora_dpp surface a consumer resolves', () => {
    expect(typeof topics.UoraDppTopicManager).toBe('function')
    expect(typeof topics.createUoraDppLookupService).toBe('function')
    expect(typeof topics.readUoraAnchor).toBe('function')
    expect(typeof topics.assertAnchorSignature).toBe('function')
    expect(typeof topics.anchorSigningPreimage).toBe('function')
    expect(typeof topics.expectedLockingKey).toBe('function')
    expect(typeof topics.didKeyFromIdentityKey).toBe('function')
    expect(typeof topics.identityKeyFromDidKey).toBe('function')
    expect(topics.UORA_ANCHOR_PREFIX).toBe('uora-anchor-v3')
    expect(topics.UORA_ANCHOR_PROTOCOL).toEqual([1, 'uora anchor v3'])
    expect(typeof topics.foldAction).toBe('function')
    expect(typeof topics.defaultAssetState).toBe('function')
    expect(topics.defaultAssetState('t_0')).toMatchObject({
      tokenId: 't_0',
      isPaused: false,
      feeRatePerKb: null
    })
  })

  it('exports the Mandala BRC-162 runtime surface a consumer resolves', () => {
    const functions = [
      'classifyOutputs',
      'classifyAdmittedInputs',
      'buildLedger',
      'specVerdicts',
      'MandalaTopicManager',
      'MandalaLookupService',
      'createMandalaLookupService',
      'MandalaStorageManager',
      'reconcileOwnerIndex',
      'MandalaReject',
      'isMandalaReject',
      'InMemoryScreeningProvider',
      'encodeEnvelope',
      'decodeEnvelope',
      'encodeAdminDetails',
      'decodeAdminDetails',
      'deployMetadata',
      'commitmentOf',
      'deployDigest',
      'verifyDeploySig',
      'verifyKeyLinkage',
      'foldAction',
      'defaultAssetState',
      'RegistryTopicManager',
      'RegistryLookupService',
      'RegistryStorage',
      'registryMembership',
      'createRegistryLookupService'
    ] as const
    for (const name of functions) expect(typeof topics[name]).toBe('function')
    expect(typeof topics.Reasons).toBe('object')
    expect(topics.MANDALA_TOPIC).toBe('tm_mandala')
    expect(topics.REGISTRY_TOPIC).toBe('tm_mandala_registry')
    expect(topics.REGISTRY_LOOKUP).toBe('ls_mandala_registry')
  })

  it('throws and recognises a typed Mandala reject through the entry point', () => {
    const reject = new topics.MandalaReject('ERR_SHAPE', 'output 0: bad shape')
    expect(reject).toBeInstanceOf(Error)
    expect(reject).toMatchObject({ code: 'ERR_SHAPE', reason: 'output 0: bad shape' })
    expect(topics.isMandalaReject(reject)).toBe(true)
    expect(topics.isMandalaReject(new Error('ERR_SHAPE'))).toBe(false)
  })

  it('does not export the Mandala API that 2.0.0 removes', () => {
    // The templates classes and the boolean admin-outpoint linkage seam: every one is replaced by
    // the BRC-162 layers above, so a lingering export would be a second, unvalidated path.
    const exported = topics as unknown as Record<string, unknown>
    for (const removed of ['MandalaToken', 'MandalaAdmin', 'ADMIN_PROTOCOL', 'REGISTRY_PROTOCOL']) {
      expect(exported[removed]).toBeUndefined()
    }
  })

  it('serves documentation for both halves of the topic', async () => {
    const manager = new topics.UoraDppTopicManager()
    await expect(manager.getDocumentation()).resolves.toContain(topics.UORA_ANCHOR_PREFIX)
  })
})
