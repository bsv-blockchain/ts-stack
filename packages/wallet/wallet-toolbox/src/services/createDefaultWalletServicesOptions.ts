import { Chain } from '../sdk/types'
import { WalletServicesOptions } from '../sdk/WalletServices.interfaces'
import { randomBytesHex } from '../utility/utilityHelpers'
import { ChaintracksClientApi } from './chaintracker/chaintracks/Api/ChaintracksClientApi'
import { ChaintracksServiceClient } from './chaintracker/chaintracks/ChaintracksServiceClient'
import { tstnArcadeUrl, tstnChaintracksUrl } from './networkConfig'

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

  // ChainTracks is derived from the per-chain Arcade host (`<arcade>/chaintracks/v1`) for
  // every public network; tstn resolves its private endpoint from the environment.
  let chaintracksUrl: string
  if (chain === 'tstn') {
    chaintracksUrl = tstnChaintracksUrl()
  } else {
    const arcadeHost = arcadeDefaultUrl(chain)
    if (arcadeHost == null || arcadeHost === '') {
      throw new Error(`chain '${chain}' has no Arcade host to derive a ChainTracks URL from`)
    }
    chaintracksUrl = `${arcadeHost.replace(/\/+$/, '')}/chaintracks/v1`
  }
  // Fiat exchange rates have no supported default endpoint. Operators that need them must
  // supply `chaintracksFiatExchangeRatesUrl` (or an `exchangeratesapiKey`) explicitly.
  const chaintracksFiatExchangeRatesUrl: string | undefined = undefined

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
 * Returns undefined only when no default is known for the chain: `tstn` until
 * `TSTN_ARCADE_URL` is supplied at runtime, and `mock`.
 */
export function arcadeDefaultUrl (chain: Chain): string | undefined {
  switch (chain) {
    case 'main':
      return 'https://arcade-v2-us-1.bsvblockchain.tech'
    case 'ttn':
      return 'https://arcade-v2-ttn-us-1.bsvblockchain.tech'
    case 'tstn':
      // Private per-deployment endpoint supplied via TSTN_ARCADE_URL (undefined when unset).
      return tstnArcadeUrl()
    case 'test':
      return 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'
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
    case 'tstn':
      // Private per-deployment endpoint supplied via TSTN_ARCADE_URL ('' when unset).
      return tstnArcadeUrl() ?? ''
    case 'mock':
      return ''
  }
}

export function arcGorillaPoolUrl (chain: Chain): string | undefined {
  return chain === 'main' ? 'https://arc.gorillapool.io' : undefined
}

/**
 * Default wallet-storage (`StorageClient`) endpoint per chain.
 * Returns undefined for chains without a public default: `tstn` is private/per-deployment,
 * and `mock`. Callers must then supply an explicit storage URL.
 */
export function defaultStorageUrl (chain: Chain): string | undefined {
  switch (chain) {
    case 'main':
      return 'https://store-us-1.bsvb.tech'
    case 'test':
      return 'https://store-testnet-us-1.bsvb.tech'
    case 'ttn':
      return 'https://store-ttn-us-1.bsvb.tech'
    case 'tstn':
      return undefined
    case 'mock':
      return undefined
  }
}
