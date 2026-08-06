import { Services } from '../Services'
import { GoChaintracksServiceClient } from '../chaintracker/chaintracks/GoChaintracksServiceClient'
import { createDefaultWalletServicesOptions } from '../createDefaultWalletServicesOptions'

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
})
