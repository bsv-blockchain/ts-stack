import { isAdvertisableURI } from '../../packages/overlays/overlay-discovery-services/dist/esm/src/utils/isAdvertisableURI.js'
import { invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const raw = utf8(data, 8192)
  invariant(typeof isAdvertisableURI(raw) === 'boolean', 'Overlay URI validator result type')

  const label = data.subarray(0, 32).toString('hex') || 'seed'
  for (const scheme of [
    'https://',
    'https+bsvauth://',
    'https+bsvauth+smf://',
    'https+bsvauth+scrypt-offchain://',
    'https+rtt://',
    'wss://'
  ]) {
    invariant(
      isAdvertisableURI(`${scheme}${label}.example.org`),
      `Overlay URI validator rejected generated ${scheme} advertisement`
    )
  }
}
