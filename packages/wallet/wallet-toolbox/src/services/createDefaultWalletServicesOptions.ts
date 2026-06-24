import { Chain } from '../sdk/types'
import { WalletServicesOptions } from '../sdk/WalletServices.interfaces'
import { randomBytesHex } from '../utility/utilityHelpers'
import { ChaintracksClientApi } from './chaintracker/chaintracks/Api/ChaintracksClientApi'
import { ChaintracksServiceClient } from './chaintracker/chaintracks/ChaintracksServiceClient'

export function createDefaultWalletServicesOptions (
  chain: Chain,
  arcCallbackUrl?: string,
  arcCallbackToken?: string,
  taalArcApiKey?: string,
  gorillaPoolArcApiKey?: string,
  bitailsApiKey?: string,
  deploymentId?: string,
  chaintracks?: ChaintracksClientApi,
  /**
   * Optional Arcade endpoint. When provided (or when a default exists for the chain via
   * `arcadeDefaultUrl`), Arcade is registered as the primary broadcaster ahead of ARC.
   * Pass an empty string to explicitly disable the per-chain default.
   */
  arcadeUrl?: string,
  /** Server-level API key (Bearer) for the Arcade endpoint, if it requires auth. */
  arcadeApiKey?: string,
  /**
   * Stable SSE callback token. Must match the Monitor's `callbackToken` so Arcade routes
   * each broadcast transaction's status events to this wallet's `/events` subscription.
   */
  arcadeCallbackToken?: string
): WalletServicesOptions {
  if (chain === 'mock') {
    throw new Error('createDefaultWalletServicesOptions does not support \'mock\' chain. Use MockServices directly.')
  }

  deploymentId ||= `wallet-toolbox-${randomBytesHex(16)}`

  // const chaintracksUrl = `https://npm-registry.babbage.systems:${chain === 'main' ? 8084 : 8083}`
  const chaintracksUrl =
    chain === 'ttn'
      ? 'https://arcade-v2-ttn-us-1.bsvblockchain.tech/chaintracks/'
      : `https://${chain}net-chaintracks.babbage.systems`
  // The mainnet endpoint is always used since these are fiat exchange rates,
  // independent of the chain being used.
  const chaintracksFiatExchangeRatesUrl = 'https://mainnet-chaintracks.babbage.systems/getFiatExchangeRates'

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
    exchangeratesapiKey: undefined,
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

  // Arcade (bsv-blockchain/arcade) primary broadcaster.
  // Opt-in: enabled only when an explicit `arcadeUrl` is provided. Callers can pass
  // `arcadeDefaultUrl(chain)` to use the known per-chain endpoint. Kept opt-in (rather
  // than defaulted on) so existing consumers' broadcaster set is unchanged until the
  // Arcade path has been validated end-to-end; flipping the default is a one-line change.
  const resolvedArcadeUrl = arcadeUrl
  if (resolvedArcadeUrl != null && resolvedArcadeUrl !== '') {
    o.arcadeUrl = resolvedArcadeUrl
    o.arcadeConfig = {
      apiKey: arcadeApiKey ?? undefined,
      deploymentId,
      // SSE (pull) flow: token scopes the /events subscription; no webhook callbackUrl
      // (Arcade rejects private/loopback URLs). Must match Monitor.options.callbackToken.
      callbackToken: arcadeCallbackToken ?? arcCallbackToken ?? undefined
    }
  }

  return o
}

/**
 * Default Arcade (bsv-blockchain/arcade) endpoint per chain.
 * Returns undefined when no public default is known for the chain (e.g. testnet not yet deployed).
 */
export function arcadeDefaultUrl (chain: Chain): string | undefined {
  switch (chain) {
    case 'main':
      return 'https://arcade-v2-us-1.bsvblockchain.tech'
    case 'ttn':
      return 'https://arcade-v2-ttn-us-1.bsvblockchain.tech'
    case 'test':
      // No public testnet Arcade endpoint deployed yet.
      return undefined
    case 'mock':
      return undefined
  }
}

export function arcDefaultUrl (chain: Chain): string {
  switch (chain) {
    case 'main':
      return 'https://arc.taal.com'
    case 'test':
      return 'https://arc-test.taal.com'
    case 'ttn':
      return 'https://arcade-v2-ttn-us-1.bsvblockchain.tech/'
    case 'mock':
      return ''
  }
}

export function arcGorillaPoolUrl (chain: Chain): string | undefined {
  return chain === 'main' ? 'https://arc.gorillapool.io' : undefined
}
