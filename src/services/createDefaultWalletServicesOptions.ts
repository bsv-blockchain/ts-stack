import { Chain } from '../sdk/types'
import { WalletServicesOptions } from '../sdk/WalletServices.interfaces'
import { randomBytesHex } from '../utility/utilityHelpers'
import { ChaintracksClientApi } from './chaintracker/chaintracks/Api/ChaintracksClientApi'
import { ChaintracksServiceClient } from './chaintracker/chaintracks/ChaintracksServiceClient'

export function createDefaultWalletServicesOptions(
  chain: Chain,
  arcCallbackUrl?: string,
  arcCallbackToken?: string,
  taalArcApiKey?: string,
  gorillaPoolArcApiKey?: string,
  bitailsApiKey?: string,
  deploymentId?: string,
  chaintracks?: ChaintracksClientApi
): WalletServicesOptions {
  deploymentId ||= `wallet-toolbox-${randomBytesHex(16)}`

  //const chaintracksUrl = `https://npm-registry.babbage.systems:${chain === 'main' ? 8084 : 8083}`
  const chaintracksUrl = `https://${chain}net-chaintracks.babbage.systems`
  // The mainnet endpoint is always used since these are fiat exchange rates,
  // independent of the chain being used.
  const chaintracksFiatExchangeRatesUrl = `https://mainnet-chaintracks.babbage.systems/getFiatExchangeRates`

  chaintracks ||= new ChaintracksServiceClient(chain, chaintracksUrl)

  const o: WalletServicesOptions = {
    chain,
    taalApiKey: undefined,
    bsvExchangeRate: {
      timestamp: new Date('2025-08-31'),
      base: 'USD',
      rate: 26.17
    },
    bsvUpdateMsecs: 1000 * 60 * 15, // 15 minutes
    fiatExchangeRates: {
      timestamp: new Date('2025-08-31'),
      base: 'USD',
      rates: {
        USD: 1,
        GBP: 0.7528,
        EUR: 0.8558
      },
      rateTimestamps: {
        USD: new Date('2025-08-31'),
        GBP: new Date('2025-08-31'),
        EUR: new Date('2025-08-31')
      }
    },
    fiatUpdateMsecs: 1000 * 60 * 60 * 24, // 24 hours
    disableMapiCallback: true, // MAPI callback's are deprecated. Rely on WalletMonitor by default.
    exchangeratesapiKey: 'bd539d2ff492bcb5619d5f27726a766f',
    chaintracksFiatExchangeRatesUrl,
    chaintracks,
    arcUrl: arcDefaultUrl(chain),
    arcConfig: {
      apiKey: taalArcApiKey ?? undefined,
      deploymentId,
      callbackUrl: arcCallbackUrl ?? undefined,
      callbackToken: arcCallbackToken ?? undefined
    },
    arcGorillaPoolUrl: arcGorillaPoolUrl(chain),
    arcGorillaPoolConfig: {
      apiKey: gorillaPoolArcApiKey ?? undefined,
      deploymentId,
      callbackUrl: arcCallbackUrl ?? undefined,
      callbackToken: arcCallbackToken ?? undefined
    },
    bitailsApiKey
  }
  return o
}

export function arcDefaultUrl(chain: Chain): string {
  const url = chain === 'main' ? 'https://arc.taal.com' : 'https://arc-test.taal.com'
  return url
}

export function arcGorillaPoolUrl(chain: Chain): string | undefined {
  const url = chain === 'main' ? 'https://arc.gorillapool.io' : undefined
  return url
}
