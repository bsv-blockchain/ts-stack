/**
 * Runtime service-endpoint configuration for the `tstn` (Teranode Scaling Test Net) network.
 *
 * Unlike `main`, `test`, and `ttn`, the tstn service endpoints are not public and must not be
 * hardcoded in this (public) source tree. They are supplied at runtime through environment
 * variables:
 *
 *   TSTN_ARCADE_URL       Arcade broadcaster / ARC endpoint base. Also the fallback host for
 *                         ChainTracks when TSTN_CHAINTRACKS_URL is unset
 *                         (`${TSTN_ARCADE_URL}/chaintracks/v1`, mirroring the ttn layout).
 *   TSTN_CHAINTRACKS_URL  ChainTracks service URL.
 *
 * tstn runs only Arcade (broadcast + merkle proofs) and ChainTracks (headers); there is no
 * WhatsOnChain / block-explorer service for tstn, so no WhatsOnChain endpoint is configured and
 * the WhatsOnChain-only lookups (raw tx, utxo status, txid status, script-hash history) are not
 * available on tstn.
 *
 * `process` is accessed defensively so importing this module remains safe in browser bundles;
 * tstn is a server-side network and these variables are only read when the selected chain is
 * tstn.
 */

function readEnv (name: string): string | undefined {
  const env = typeof process !== 'undefined' ? process.env : undefined
  const value = env?.[name]
  return value != null && value.trim() !== '' ? value.trim() : undefined
}

const stripTrailingSlash = (url: string): string => {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end--
  return url.slice(0, end)
}

/** Arcade broadcaster / ARC endpoint for tstn, or `undefined` when `TSTN_ARCADE_URL` is unset. */
export function tstnArcadeUrl (): string | undefined {
  return readEnv('TSTN_ARCADE_URL')
}

/**
 * ChainTracks service URL for tstn. Falls back to `${TSTN_ARCADE_URL}/chaintracks/v1` when
 * `TSTN_CHAINTRACKS_URL` is unset (mirrors the ttn layout). Throws when neither is configured.
 */
export function tstnChaintracksUrl (): string {
  const explicit = readEnv('TSTN_CHAINTRACKS_URL')
  if (explicit != null) return explicit
  const arcade = tstnArcadeUrl()
  if (arcade != null) return `${stripTrailingSlash(arcade)}/chaintracks/v1`
  throw new Error(
    'tstn chain requires a ChainTracks URL: set TSTN_CHAINTRACKS_URL (or TSTN_ARCADE_URL) in the environment.'
  )
}
