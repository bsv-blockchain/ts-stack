import { Services } from '../Services'
import { Arcade } from '../providers/Arcade'
import { arcadeDefaultUrl, createDefaultWalletServicesOptions } from '../createDefaultWalletServicesOptions'

/**
 * Verifies the Arcade-first / ARC-fallback wiring in Services and the option defaults.
 * No network is performed: Services construction only instantiates providers.
 */

const ARCADE_URL = 'https://arcade-v2-ttn-us-1.bsvblockchain.tech'

describe('Services Arcade wiring', () => {
  test('arcadeDefaultUrl maps all public Arcade deployments', () => {
    expect(arcadeDefaultUrl('main')).toBe('https://arcade-v2-us-1.bsvblockchain.tech')
    expect(arcadeDefaultUrl('ttn')).toBe('https://arcade-v2-ttn-us-1.bsvblockchain.tech')
    expect(arcadeDefaultUrl('test')).toBe('https://arcade-v2-testnet-us-1.bsvblockchain.tech')
  })

  test('arcadeDefaultUrl for tstn is driven by TSTN_ARCADE_URL', () => {
    const prev = process.env.TSTN_ARCADE_URL
    try {
      delete process.env.TSTN_ARCADE_URL
      // No private endpoint hardcoded: undefined until supplied at runtime.
      expect(arcadeDefaultUrl('tstn')).toBeUndefined()
      process.env.TSTN_ARCADE_URL = 'https://tstn.example.internal'
      expect(arcadeDefaultUrl('tstn')).toBe('https://tstn.example.internal')
    } finally {
      if (prev === undefined) delete process.env.TSTN_ARCADE_URL
      else process.env.TSTN_ARCADE_URL = prev
    }
  })

  test('back-compat: no arcadeUrl → no Arcade provider, broadcaster set unchanged', () => {
    const options = createDefaultWalletServicesOptions('test')
    expect(options.arcadeUrl).toBeUndefined()
    const services = new Services(options)
    expect(services.arcade).toBeUndefined()
    const names = services.postBeefServices.allServices.length // smoke: collection built
    expect(names).toBeGreaterThan(0)
    expect(services.postBeefServices.services.some(s => s.name === 'ArcadeBeef')).toBe(false)
  })

  test('arcadeUrl provided → Arcade registered FIRST in postBeefServices', () => {
    const options = createDefaultWalletServicesOptions(
      'test',
      undefined, // arcCallbackUrl
      'cb-token', // arcCallbackToken
      undefined, // taalArcApiKey
      undefined, // gorillaPoolArcApiKey
      undefined, // bitailsApiKey
      undefined, // deploymentId
      undefined, // chaintracks
      ARCADE_URL, // arcadeUrl
      undefined, // arcadeApiKey
      'cb-token' // arcadeCallbackToken (matches SSE token)
    )
    expect(options.arcadeUrl).toBe(ARCADE_URL)
    expect(options.arcadeConfig?.callbackToken).toBe('cb-token')

    const services = new Services(options)
    expect(services.arcade).toBeInstanceOf(Arcade)
    // Arcade must be the FIRST broadcaster tried under 'UntilSuccess'.
    expect(services.postBeefServices.services[0].name).toBe('ArcadeBeef')
    // ARC (Taal) remains present as fallback.
    expect(services.postBeefServices.services.some(s => s.name === 'TaalArcBeef')).toBe(true)
    // Arcade is also a getMerklePath provider (proof acquisition), ahead of WhatsOnChain.
    expect(services.getMerklePathServices.services[0].name).toBe('Arcade')
    expect(services.getMerklePathServices.services.some(s => s.name === 'WhatsOnChain')).toBe(true)
    // Existing explorer status remains first; Arcade is the independent
    // fallback and is the only status provider on explorer-free networks.
    expect(services.getStatusForTxidsServices.services.map(s => s.name)).toEqual(['WhatsOnChain', 'Arcade'])
  })

  test('isUtxo rejects an inconclusive provider result instead of treating it as spent', async () => {
    const services = new Services(createDefaultWalletServicesOptions('test'))
    jest.spyOn(services, 'getUtxoStatus').mockResolvedValue({
      name: '<noservices>',
      status: 'error',
      details: []
    })

    await expect(services.isUtxo({ lockingScript: [0], txid: '11'.repeat(32), vout: 0 } as any)).rejects.toThrow(
      'No UTXO provider returned a conclusive result'
    )
  })

  test('isUtxo returns a conclusive provider verdict', async () => {
    const services = new Services(createDefaultWalletServicesOptions('test'))
    jest.spyOn(services, 'getUtxoStatus').mockResolvedValue({
      name: 'test-provider',
      status: 'success',
      details: [],
      isUtxo: true
    })

    await expect(services.isUtxo({ lockingScript: [0], txid: '22'.repeat(32), vout: 1 } as any)).resolves.toBe(true)
  })

  test('explicit empty-string arcadeUrl keeps Arcade disabled', () => {
    const options = createDefaultWalletServicesOptions(
      'test',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '' // arcadeUrl explicitly empty
    )
    expect(options.arcadeUrl).toBeUndefined()
  })
})
