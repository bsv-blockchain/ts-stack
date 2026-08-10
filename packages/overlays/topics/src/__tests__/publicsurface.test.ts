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
  })

  it('serves documentation for both halves of the topic', async () => {
    const manager = new topics.UoraDppTopicManager()
    await expect(manager.getDocumentation()).resolves.toContain(topics.UORA_ANCHOR_PREFIX)
  })
})
