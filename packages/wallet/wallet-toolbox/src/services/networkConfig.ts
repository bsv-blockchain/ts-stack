import { Chain } from '../sdk/types'

/**
 * Runtime service-endpoint configuration for Teranode networks that do not
 * have a public, operator-independent service endpoint.
 *
 * Unlike `main`, `test`, and `ttn`, the stn/tstn service endpoints are not public and must not be
 * hardcoded in this (public) source tree. They are supplied at runtime through environment
 * variables:
 *
 *   STN_ARCADE_URL        STN Arcade broadcaster / ARC endpoint base.
 *   STN_CHAINTRACKS_URL   STN ChainTracks service URL.
 *   TSTN_ARCADE_URL       Arcade broadcaster / ARC endpoint base. Also the fallback host for
 *                         ChainTracks when TSTN_CHAINTRACKS_URL is unset
 *                         (`${TSTN_ARCADE_URL}/chaintracks/v1`, mirroring the ttn layout).
 *   TSTN_CHAINTRACKS_URL  ChainTracks service URL.
 *
 * stn/tstn run only operator-configured Arcade and ChainTracks services; there is no
 * documented WhatsOnChain service for them, so no WhatsOnChain endpoint is configured and
 * the WhatsOnChain-only lookups (raw tx, utxo status, txid status, script-hash history) are not
 * available on stn/tstn.
 *
 * `process` is accessed defensively so importing this module remains safe in
 * browser bundles. Browser applications can still supply an explicit
 * ChaintracksClientApi without relying on environment variables.
 */

function readEnv(name: string): string | undefined {
  const env = typeof process !== 'undefined' ? process.env : undefined
  const value = env?.[name]
  return value != null && value.trim() !== '' ? value.trim() : undefined
}

/** Credential-free public Arcade host for supported networks. */
export function publicArcadeUrl(chain: Chain): string | undefined {
  switch (chain) {
    case 'main':
      return 'https://arcade-v2-us-1.bsvblockchain.tech'
    case 'test':
      return 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'
    case 'ttn':
      return 'https://arcade-v2-ttn-us-1.bsvblockchain.tech'
    case 'stn':
    case 'tstn':
    case 'mock':
      return undefined
  }
}

const stripTrailingSlash = (url: string): string => {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end--
  return url.slice(0, end)
}

/** Arcade broadcaster / ARC endpoint for tstn, or `undefined` when `TSTN_ARCADE_URL` is unset. */
export function tstnArcadeUrl(): string | undefined {
  return readEnv('TSTN_ARCADE_URL')
}

/** Arcade broadcaster / ARC endpoint for stn, or `undefined` when unset. */
export function stnArcadeUrl(): string | undefined {
  return readEnv('STN_ARCADE_URL')
}

/**
 * ChainTracks service URL for tstn. Falls back to `${TSTN_ARCADE_URL}/chaintracks/v1` when
 * `TSTN_CHAINTRACKS_URL` is unset (mirrors the ttn layout). Throws when neither is configured.
 */
export function tstnChaintracksUrl(): string {
  const explicit = readEnv('TSTN_CHAINTRACKS_URL')
  if (explicit != null) return explicit
  const arcade = tstnArcadeUrl()
  if (arcade != null) return `${stripTrailingSlash(arcade)}/chaintracks/v1`
  throw new Error(
    'tstn chain requires a ChainTracks URL: set TSTN_CHAINTRACKS_URL (or TSTN_ARCADE_URL) in the environment.'
  )
}

/**
 * ChainTracks service URL for stn. Falls back to the configured Arcade host's
 * legacy-compatible path when STN_CHAINTRACKS_URL is unset.
 */
export function stnChaintracksUrl(): string {
  const explicit = readEnv('STN_CHAINTRACKS_URL')
  if (explicit != null) return explicit
  const arcade = stnArcadeUrl()
  if (arcade != null) return `${stripTrailingSlash(arcade)}/chaintracks/v1`
  throw new Error(
    'stn chain requires a ChainTracks URL: set STN_CHAINTRACKS_URL (or STN_ARCADE_URL) in the environment.'
  )
}
