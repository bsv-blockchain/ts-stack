import { Services } from '../Services'
import {
  arcadeDefaultUrl,
  arcDefaultUrl,
  createDefaultWalletServicesOptions
} from '../createDefaultWalletServicesOptions'
import { regtestChaintracksUrl } from '../networkConfig'

/**
 * regtest wiring.
 *
 * A regtest deployment is private: its Arcade and ChainTracks endpoints are supplied at runtime
 * through REGTEST_ARCADE_URL / REGTEST_CHAINTRACKS_URL, never hardcoded. Like tstn it runs only
 * Arcade + ChainTracks, so the WhatsOnChain provider must not be registered for it.
 */

const ARCADE = 'https://regtest-arcade.example.internal'

describe('regtest network wiring', () => {
  let prevArcade: string | undefined
  let prevChaintracks: string | undefined

  beforeEach(() => {
    prevArcade = process.env.REGTEST_ARCADE_URL
    prevChaintracks = process.env.REGTEST_CHAINTRACKS_URL
    process.env.REGTEST_ARCADE_URL = ARCADE
    delete process.env.REGTEST_CHAINTRACKS_URL
  })

  afterEach(() => {
    if (prevArcade === undefined) delete process.env.REGTEST_ARCADE_URL
    else process.env.REGTEST_ARCADE_URL = prevArcade
    if (prevChaintracks === undefined) delete process.env.REGTEST_CHAINTRACKS_URL
    else process.env.REGTEST_CHAINTRACKS_URL = prevChaintracks
  })

  test('service URLs come from the environment', () => {
    expect(arcadeDefaultUrl('regtest')).toBe(ARCADE)
    expect(arcDefaultUrl('regtest')).toBe(ARCADE)
    // ChainTracks falls back to the Arcade host when REGTEST_CHAINTRACKS_URL is unset.
    expect(regtestChaintracksUrl()).toBe(`${ARCADE}/chaintracks/v1`)
    expect(createDefaultWalletServicesOptions('regtest').arcUrl).toBe(ARCADE)

    process.env.REGTEST_CHAINTRACKS_URL = 'https://regtest-chaintracks.example.internal/v1'
    expect(regtestChaintracksUrl()).toBe('https://regtest-chaintracks.example.internal/v1')
    expect(createDefaultWalletServicesOptions('regtest').chain).toBe('regtest')
  })

  test('requires a ChainTracks endpoint when neither variable is set', () => {
    delete process.env.REGTEST_ARCADE_URL
    expect(arcadeDefaultUrl('regtest')).toBeUndefined()
    expect(() => regtestChaintracksUrl()).toThrow('regtest chain requires a ChainTracks URL')
  })

  test('Arcade is wired and WhatsOnChain is not registered', () => {
    const options = createDefaultWalletServicesOptions(
      'regtest',
      undefined, // arcCallbackUrl
      'cb-token', // arcCallbackToken
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      arcadeDefaultUrl('regtest'), // arcadeUrl
      undefined,
      'cb-token'
    )
    const services = new Services(options)

    expect(services.postBeefServices.services[0].name).toBe('ArcadeBeef')
    expect(services.getMerklePathServices.services[0].name).toBe('Arcade')

    const noWoc = (names: Array<{ name: string }>): boolean => !names.some(s => s.name === 'WhatsOnChain')
    expect(noWoc(services.postBeefServices.services)).toBe(true)
    expect(noWoc(services.getMerklePathServices.services)).toBe(true)
    expect(services.getRawTxServices.services).toHaveLength(0)
    expect(services.getUtxoStatusServices.services).toHaveLength(0)
    expect(services.getScriptHashHistoryServices.services).toHaveLength(0)
  })
})
