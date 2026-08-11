import { Chain } from '../sdk/types'
import { WalletServicesOptions } from '../sdk/WalletServices.interfaces'
import { randomBytesHex } from '../utility/utilityHelpers'
import { ChaintracksClientApi } from './chaintracker/chaintracks/Api/ChaintracksClientApi'
import { ChaintracksServiceClient } from './chaintracker/chaintracks/ChaintracksServiceClient'
import { GoChaintracksServiceClient } from './chaintracker/chaintracks/GoChaintracksServiceClient'
import { publicArcadeUrl, stnArcadeUrl, stnChaintracksUrl, tstnArcadeUrl, tstnChaintracksUrl } from './networkConfig'

function stripTrailingSlash(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end--
  return value.slice(0, end)
}

function configuredChaintracksClient(chain: Chain, serviceUrl: string): ChaintracksClientApi {
  let path = ''
  try {
    path = stripTrailingSlash(new URL(serviceUrl).pathname)
  } catch {
    // Preserve the legacy client's existing validation/error behavior for an
    // operator-supplied non-URL value.
  }
  if (path.endsWith('/v2')) return new GoChaintracksServiceClient(chain, serviceUrl)
  return new ChaintracksServiceClient(chain, serviceUrl)
}

/**
 * True when running under a browser-style runtime — a real browser tab, or
 * the embedded webview a desktop wallet shell hosts its wallet logic in
 * (Metanet Client / User Wallet are Tauri WKWebViews) — where `fetch` is
 * subject to CORS enforcement that Node-style runtimes do not apply.
 */
function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined' && window.document !== undefined
}

/**
 * Returns the credential-free default ChainTracks client for a supported
 * public network, or an operator-configured client for stn/tstn.
 *
 * BROWSER RUNTIMES get the legacy CORS-enabled Chaintracks service for
 * main/test. The Go Chaintracks deployments (`arcade-v2-*.bsvblockchain.tech`)
 * currently serve no `Access-Control-Allow-Origin` header and answer OPTIONS
 * preflights with 404 (verified live 2026-08-11), so every fetch from a
 * browser-hosted wallet is CORS-blocked (WebKit surfaces it as
 * `TypeError: Load failed`) and the wallet loses `getHeight`, headers and
 * merkle-root validation wholesale. The repository service contract
 * (AGENTS.md: "browser, mobile, and unknown-domain clients must not be
 * silently blocked by CORS") requires a default that browsers can actually
 * reach. Once the Go deployments serve CORS (and a browser-run conformance
 * check proves it), this branch can be removed and browsers can share the v2
 * default. Node runtimes are unchanged.
 */
export function createDefaultChaintracksClient(chain: Exclude<Chain, 'mock'>): ChaintracksClientApi {
  switch (chain) {
    case 'main':
    case 'test':
      if (isBrowserRuntime()) {
        return new ChaintracksServiceClient(chain, `https://${chain}net-chaintracks.babbage.systems`)
      }
      return new GoChaintracksServiceClient(chain, arcadeDefaultUrl(chain)!, {
        apiPrefix: '/chaintracks/v2'
      })
    case 'ttn':
      // No legacy CORS-enabled deployment exists for ttn — browser callers
      // inherit the v2 endpoint until it serves CORS.
      return new GoChaintracksServiceClient(chain, arcadeDefaultUrl(chain)!, {
        apiPrefix: '/chaintracks/v2'
      })
    case 'stn':
      return configuredChaintracksClient(chain, stnChaintracksUrl())
    case 'tstn':
      return configuredChaintracksClient(chain, tstnChaintracksUrl())
  }
}

export function createDefaultWalletServicesOptions(
  ...[
    chain,
    arcCallbackUrl,
    arcCallbackToken,
    taalArcApiKey,
    gorillaPoolArcApiKey,
    bitailsApiKey,
    deploymentId,
    chaintracks,
    arcadeUrl,
    arcadeApiKey,
    arcadeCallbackToken
  ]: [
    chain: Chain,
    arcCallbackUrl?: string,
    arcCallbackToken?: string,
    taalArcApiKey?: string,
    gorillaPoolArcApiKey?: string,
    bitailsApiKey?: string,
    deploymentId?: string,
    chaintracks?: ChaintracksClientApi,
    /**
     * Optional Arcade endpoint. TTN uses its public Arcade endpoint by default; other
     * chains remain opt-in. Arcade is registered as the primary broadcaster ahead of ARC.
     * Pass an empty string to explicitly disable the TTN default.
     */
    arcadeUrl?: string,
    /** Server-level API key (Bearer) for the Arcade endpoint, if it requires auth. */
    arcadeApiKey?: string,
    /**
     * Stable SSE callback token. Must match the Monitor's `callbackToken` so Arcade routes
     * each broadcast transaction's status events to this wallet's `/events` subscription.
     */
    arcadeCallbackToken?: string
  ]
): WalletServicesOptions {
  if (chain === 'mock') {
    throw new Error("createDefaultWalletServicesOptions does not support 'mock' chain. Use MockServices directly.")
  }

  deploymentId ||= `wallet-toolbox-${randomBytesHex(16)}`

  // The mainnet endpoint is always used since these are fiat exchange rates,
  // independent of the chain being used.
  const chaintracksFiatExchangeRatesUrl = 'https://mainnet-chaintracks.babbage.systems/getFiatExchangeRates'

  chaintracks ||= createDefaultChaintracksClient(chain)

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
    // Arcade uses EF at /tx. Legacy ARC uses BEEF at /v1/tx and has no
    // compatible public TTN endpoint, so do not install it as a TTN fallback.
    arcUrl: chain === 'ttn' ? '' : arcDefaultUrl(chain),
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

  // Arcade (bsv-blockchain/arcade) primary broadcaster. TTN has no compatible
  // public ARC fallback, so it defaults to the known TTN Arcade endpoint. Existing
  // mainnet/testnet provider sets remain opt-in and therefore unchanged.
  const resolvedArcadeUrl = arcadeUrl ?? (chain === 'ttn' ? arcadeDefaultUrl(chain) : undefined)
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
 * Returns undefined when no public default is known for the chain.
 */
export function arcadeDefaultUrl(chain: Chain): string | undefined {
  switch (chain) {
    case 'main':
    case 'test':
    case 'ttn':
      return publicArcadeUrl(chain)
    case 'stn':
      return stnArcadeUrl()
    case 'tstn':
      // Private per-deployment endpoint supplied via TSTN_ARCADE_URL (undefined when unset).
      return tstnArcadeUrl()
    case 'mock':
      return undefined
  }
}

export function arcDefaultUrl(chain: Chain): string {
  switch (chain) {
    case 'main':
      return 'https://arc.taal.com'
    case 'test':
      return 'https://arc-test.taal.com'
    case 'stn':
      return stnArcadeUrl() ?? ''
    case 'ttn':
      return ''
    case 'tstn':
      // Private per-deployment endpoint supplied via TSTN_ARCADE_URL ('' when unset).
      return tstnArcadeUrl() ?? ''
    case 'mock':
      return ''
  }
}

export function arcGorillaPoolUrl(chain: Chain): string | undefined {
  return chain === 'main' ? 'https://arc.gorillapool.io' : undefined
}
