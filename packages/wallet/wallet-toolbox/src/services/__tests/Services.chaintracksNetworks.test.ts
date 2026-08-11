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

describe('browser-runtime ChainTracks defaults (CORS-reachable service contract)', () => {
  // The Go Chaintracks deployments serve no Access-Control-Allow-Origin and
  // 404 OPTIONS preflights (verified live 2026-08-11), so a browser/webview
  // wallet given that default loses getHeight/headers/root validation
  // wholesale ("browser … clients must not be silently blocked by CORS",
  // AGENTS.md). These cells pin the browser-context default to the legacy
  // CORS-enabled service until the v2 deployments serve CORS.
  const g = globalThis as { window?: unknown }

  afterEach(() => {
    delete g.window
  })

  test.each(['main', 'test'] as const)(
    '%s under a browser runtime defaults to the legacy CORS-enabled Chaintracks service',
    chain => {
      g.window = { document: {} }
      const client = createDefaultWalletServicesOptions(chain).chaintracks
      expect(client).toBeInstanceOf(ChaintracksServiceClient)
      expect(client).not.toBeInstanceOf(GoChaintracksServiceClient)
      expect((client as ChaintracksServiceClient).serviceUrl).toBe(
        `https://${chain}net-chaintracks.babbage.systems`
      )
    }
  )

  test('a window WITHOUT a document (a Node global shim) is not a browser runtime', () => {
    g.window = {}
    expect(createDefaultWalletServicesOptions('main').chaintracks).toBeInstanceOf(GoChaintracksServiceClient)
  })
})

describe('Services.getHeight — WhatsOnChain belt behind the chaintracks single point of failure', () => {
  test('a failing chaintracks falls back to WhatsOnChain chain info', async () => {
    const services = new Services('main')
    services.options.chaintracks = {
      currentHeight: async () => {
        throw new Error('Load failed') // the CORS-blocked browser fetch shape
      }
    } as unknown as typeof services.options.chaintracks
    ;(services as unknown as { whatsonchain: { getChainInfo: () => Promise<{ blocks: number }> } }).whatsonchain = {
      getChainInfo: async () => ({ blocks: 900_123 })
    }
    await expect(services.getHeight()).resolves.toBe(900_123)
  })

  test('when the belt ALSO fails, the ORIGINAL chaintracks error is rethrown', async () => {
    const services = new Services('main')
    const original = new Error('chaintracks unreachable')
    services.options.chaintracks = {
      currentHeight: async () => {
        throw original
      }
    } as unknown as typeof services.options.chaintracks
    ;(services as unknown as { whatsonchain: { getChainInfo: () => Promise<{ blocks: number }> } }).whatsonchain = {
      getChainInfo: async () => {
        throw new Error('woc down too')
      }
    }
    await expect(services.getHeight()).rejects.toBe(original)
  })
})
