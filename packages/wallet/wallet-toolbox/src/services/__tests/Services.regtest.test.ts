import { Services } from '../Services'
import {
  arcadeDefaultUrl,
  arcDefaultUrl,
  createDefaultWalletServicesOptions
} from '../createDefaultWalletServicesOptions'
import { regtestChaintracksUrl } from '../networkConfig'
import * as clientEntry from '../../index.client'
import * as mobileEntry from '../../index.mobile'
import * as allEntry from '../../index.all'
import SdkWhatsOnChain from '../providers/SdkWhatsOnChain'
import { WhatsOnChainNoServices } from '../providers/WhatsOnChain'
import { ChaintracksClientApi } from '../chaintracker/chaintracks/Api/ChaintracksClientApi'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

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
    // Regtest runs Arcade (EF at /tx), never legacy ARC (BEEF at /v1/tx).
    expect(arcDefaultUrl('regtest')).toBe('')
    // ChainTracks falls back to the Arcade host when REGTEST_CHAINTRACKS_URL is unset.
    expect(regtestChaintracksUrl()).toBe(`${ARCADE}/chaintracks/v1`)
    expect(createDefaultWalletServicesOptions('regtest').arcUrl).toBe('')
    expect(createDefaultWalletServicesOptions('regtest').arcadeUrl).toBe(ARCADE)

    process.env.REGTEST_CHAINTRACKS_URL = 'https://regtest-chaintracks.example.internal/v1'
    expect(regtestChaintracksUrl()).toBe('https://regtest-chaintracks.example.internal/v1')
    expect(createDefaultWalletServicesOptions('regtest').chain).toBe('regtest')
  })

  test.each([
    ['index.all', allEntry],
    ['index.client', clientEntry],
    ['index.mobile', mobileEntry]
  ])('%s exports the regtest endpoint helpers', (_name, entry) => {
    expect(entry.regtestArcadeUrl()).toBe(ARCADE)
    expect(entry.regtestChaintracksUrl()).toBe(`${ARCADE}/chaintracks/v1`)
  })

  test('requires a ChainTracks endpoint when neither variable is set', () => {
    delete process.env.REGTEST_ARCADE_URL
    expect(arcadeDefaultUrl('regtest')).toBeUndefined()
    expect(arcDefaultUrl('regtest')).toBe('')
    expect(() => regtestChaintracksUrl()).toThrow('regtest chain requires a ChainTracks URL')
  })

  test('the default factory wires Arcade from the environment and no legacy ARC', () => {
    // No explicit arcadeUrl: this is what `new Services('regtest')` builds.
    const services = new Services('regtest')

    expect(services.postBeefServices.services.map(s => s.name)).toEqual(['ArcadeBeef'])
    expect(services.getMerklePathServices.services.map(s => s.name)).toEqual(['Arcade'])

    // An explicit empty arcadeUrl still disables the default, leaving no broadcaster.
    const disabled = createDefaultWalletServicesOptions(
      'regtest',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '' // arcadeUrl
    )
    expect(disabled.arcadeUrl).toBeUndefined()
    expect(disabled.arcUrl).toBe('')
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

  test('WhatsOnChain accepts regtest but has no explorer endpoint for it', () => {
    expect(new SdkWhatsOnChain().network).toBe('main')
    const woc = new SdkWhatsOnChain('regtest')
    expect(woc.network).toBe('regtest')
    expect((woc as unknown as { URL: string }).URL).toBe('')
    expect(() => new SdkWhatsOnChain('regnet' as never)).toThrow('WhatsOnChain network is invalid.')
  })

  test.each(['regtest', 'tstn'] as const)('WhatsOnChain for %s refuses to send any request', async network => {
    const request = jest.fn()
    const woc = new WhatsOnChainNoServices(network, { httpClient: { request } })
    expect(woc.isAvailable).toBe(false)
    expect(new WhatsOnChainNoServices('test', { httpClient: { request } }).isAvailable).toBe(true)

    const refusal = `WhatsOnChain has no service for network '${network}'.`
    const hash = '00'.repeat(32)
    await expect(woc.getBlockHeaderByHash(hash)).rejects.toThrow(refusal)
    await expect(woc.getChainInfo()).rejects.toThrow(refusal)
    await expect(woc.updateBsvExchangeRate()).rejects.toThrow(refusal)
    await expect(woc.isValidRootForHeight(hash, 1)).rejects.toThrow(refusal)
    await expect(woc.currentHeight()).rejects.toThrow('Failed to get current height from WhatsOnChain.')
    expect(request).not.toHaveBeenCalled()
  })

  test('hashToHeader does not fall back to WhatsOnChain for regtest', async () => {
    process.env.REGTEST_CHAINTRACKS_URL = 'https://regtest-chaintracks.example.internal/v1'
    const chaintracks = {
      findHeaderForBlockHash: jest.fn(async () => undefined)
    } as unknown as ChaintracksClientApi
    const options = createDefaultWalletServicesOptions(
      'regtest',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      chaintracks
    )
    expect(options.chaintracks).toBe(chaintracks)
    const services = new Services(options)
    const fallback = jest.spyOn(services.whatsonchain, 'getBlockHeaderByHash')

    await expect(services.hashToHeader('11'.repeat(32))).rejects.toBeInstanceOf(WERR_INVALID_PARAMETER)
    expect(chaintracks.findHeaderForBlockHash).toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })
})
