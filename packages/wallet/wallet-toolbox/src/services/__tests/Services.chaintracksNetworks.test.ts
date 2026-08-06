import { Services } from '../Services'
import { ChaintracksServiceClient } from '../chaintracker/chaintracks/ChaintracksServiceClient'
import { GoChaintracksServiceClient } from '../chaintracker/chaintracks/GoChaintracksServiceClient'
import {
  arcadeDefaultUrl,
  arcDefaultUrl,
  createDefaultWalletServicesOptions
} from '../createDefaultWalletServicesOptions'

describe('ChainTracks network defaults', () => {
  let stnChaintracks: string | undefined
  let stnArcade: string | undefined

  beforeEach(() => {
    stnChaintracks = process.env.STN_CHAINTRACKS_URL
    stnArcade = process.env.STN_ARCADE_URL
    process.env.STN_CHAINTRACKS_URL = 'https://stn.example/chaintracks/v2'
    process.env.STN_ARCADE_URL = 'https://stn.example'
  })

  afterEach(() => {
    if (stnChaintracks == null) delete process.env.STN_CHAINTRACKS_URL
    else process.env.STN_CHAINTRACKS_URL = stnChaintracks
    if (stnArcade == null) delete process.env.STN_ARCADE_URL
    else process.env.STN_ARCADE_URL = stnArcade
  })

  test.each(['main', 'test', 'ttn'] as const)('%s defaults to the credential-free v2 client', chain => {
    expect(createDefaultWalletServicesOptions(chain).chaintracks).toBeInstanceOf(GoChaintracksServiceClient)
  })

  test('stn uses an explicit v2 endpoint without adding explorer fallbacks', () => {
    const options = createDefaultWalletServicesOptions('stn')
    expect(options.chaintracks).toBeInstanceOf(GoChaintracksServiceClient)
    const services = new Services(options)
    const names = [
      ...services.getMerklePathServices.services,
      ...services.getRawTxServices.services,
      ...services.getUtxoStatusServices.services,
      ...services.getStatusForTxidsServices.services,
      ...services.getScriptHashHistoryServices.services
    ].map(service => service.name)
    expect(names).not.toContain('WhatsOnChain')
    expect(names).not.toContain('Bitails')
  })

  test('stn falls back to an operator Arcade v1 path without aliasing another network', () => {
    delete process.env.STN_CHAINTRACKS_URL
    process.env.STN_ARCADE_URL = 'https://stn.example///'

    expect(arcadeDefaultUrl('stn')).toBe('https://stn.example///')
    expect(arcDefaultUrl('stn')).toBe('https://stn.example///')
    expect(createDefaultWalletServicesOptions('stn').chaintracks).toBeInstanceOf(ChaintracksServiceClient)
  })

  test('default service factories reject mock-chain construction', () => {
    expect(() => createDefaultWalletServicesOptions('mock')).toThrow("does not support 'mock' chain")
    expect(() => new Services('mock')).toThrow("Use MockServices for 'mock' chain")
  })
})
