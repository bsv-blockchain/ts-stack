import { Services } from '../Services'
import { arcadeDefaultUrl, arcDefaultUrl, createDefaultWalletServicesOptions } from '../createDefaultWalletServicesOptions'

/**
 * tstn (Teranode Scaling Test Net) wiring.
 *
 * tstn service endpoints are private and supplied at runtime via env vars (never hardcoded).
 * tstn runs only Arcade + ChainTracks — there is no WhatsOnChain / explorer service, so the
 * WhatsOnChain provider must not be registered in any Services collection for tstn.
 */

const ARCADE = 'https://tstn-arcade.example.internal'

describe('tstn network wiring', () => {
  let prevArcade: string | undefined
  let prevChaintracks: string | undefined

  beforeEach(() => {
    prevArcade = process.env.TSTN_ARCADE_URL
    prevChaintracks = process.env.TSTN_CHAINTRACKS_URL
    process.env.TSTN_ARCADE_URL = ARCADE
    delete process.env.TSTN_CHAINTRACKS_URL
  })

  afterEach(() => {
    if (prevArcade === undefined) delete process.env.TSTN_ARCADE_URL
    else process.env.TSTN_ARCADE_URL = prevArcade
    if (prevChaintracks === undefined) delete process.env.TSTN_CHAINTRACKS_URL
    else process.env.TSTN_CHAINTRACKS_URL = prevChaintracks
  })

  test('service URLs come from the environment', () => {
    expect(arcadeDefaultUrl('tstn')).toBe(ARCADE)
    expect(arcDefaultUrl('tstn')).toBe(ARCADE)
    // ChainTracks falls back to the Arcade host when TSTN_CHAINTRACKS_URL is unset.
    const options = createDefaultWalletServicesOptions('tstn')
    expect(options.arcUrl).toBe(ARCADE)

    process.env.TSTN_CHAINTRACKS_URL = 'https://tstn-chaintracks.example.internal/v1'
    const options2 = createDefaultWalletServicesOptions('tstn')
    expect(options2.chain).toBe('tstn')
  })

  test('Arcade is wired and WhatsOnChain is not registered', () => {
    const options = createDefaultWalletServicesOptions(
      'tstn',
      undefined, // arcCallbackUrl
      'cb-token', // arcCallbackToken
      undefined, undefined, undefined, undefined, undefined,
      arcadeDefaultUrl('tstn'), // arcadeUrl
      undefined,
      'cb-token'
    )
    const services = new Services(options)

    // Arcade is the primary broadcaster and merkle-proof provider.
    expect(services.postBeefServices.services[0].name).toBe('ArcadeBeef')
    expect(services.getMerklePathServices.services[0].name).toBe('Arcade')

    // No WhatsOnChain / explorer service on tstn.
    const noWoc = (names: Array<{ name: string }>): boolean => !names.some(s => s.name === 'WhatsOnChain')
    expect(noWoc(services.postBeefServices.services)).toBe(true)
    expect(noWoc(services.getMerklePathServices.services)).toBe(true)
    expect(services.getRawTxServices.services).toHaveLength(0)
    expect(services.getUtxoStatusServices.services).toHaveLength(0)
    expect(services.getStatusForTxidsServices.services).toHaveLength(0)
    expect(services.getScriptHashHistoryServices.services).toHaveLength(0)
  })
})
