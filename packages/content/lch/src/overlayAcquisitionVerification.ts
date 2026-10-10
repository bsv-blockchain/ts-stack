import { Hash, Utils } from '@bsv/sdk'
import { lchAssert } from './errors.js'
import { PublicBRC77Verifier } from './signatures.js'
import type { LCHSignatureVerifier } from './types.js'

/** One bounded assessment, shared by header, terms, delegation and License
 * checks. Cache only actual cryptographic results for identical preimages and
 * signature bytes; it never establishes authority or policy by itself.
 */
export function lchOverlaySignatureBudget(current: () => void): LCHSignatureVerifier {
  const verifier = new PublicBRC77Verifier(),
    cache = new Map<string, boolean>()
  let checks = 0
  return {
    async verify(preimage, signature) {
      current()
      const key = Utils.toHex(Hash.sha256([...Hash.sha256(preimage), ...Hash.sha256(signature)]))
      if (cache.has(key)) return cache.get(key)!
      lchAssert(++checks <= 256, 'ERR_LCH_SIGNATURE', 'Actual LCH signature-check budget exceeded')
      const valid = await verifier.verify(preimage, signature)
      current()
      cache.set(key, valid)
      return valid
    }
  }
}
