import BigNumber from '../../primitives/BigNumber.js'
import Curve from '../../primitives/Curve.js'
import PublicKey from '../../primitives/PublicKey.js'
import { sha256hmac } from '../../primitives/Hash.js'
import { toArray } from '../../primitives/utils.js'
import { identity } from '../../overlay-tools/OutputProtocolSchema.js'
import { outputAssert } from '../../overlay-tools/OutputProtocolError.js'

/** Immutable BRC-197 family. Different executable bytes require a different family. */
export const REVENUE_LISTING_FAMILY = 'https://bsv.brc.dev/tokens/0197#revenue-listing-v1'
/** Fixed transparent BRC-42/BRC-29 child profile. This deliberate key reuse
 * makes no privacy claim; protected signers must never expose a child scalar.
 */
export const REVENUE_LISTING_AUTHORITY_PROTOCOL = Object.freeze([2, '3241645161d8'] as const)
export const REVENUE_LISTING_AUTHORITY_KEY_ID = 'brc197 authority'

/** Public derivation only. With `anyone` (G), the BRC-42 shared point is the
 * identity point itself; the HMAC tweak is public. This calculation
 * establishes neither authorized genesis nor the on-chain activation proof.
 */
export function revenueListingChildPublicKey(rootIdentity: string): string {
  const root = PublicKey.fromString(identity(rootIdentity))
  const invoice = `${REVENUE_LISTING_AUTHORITY_PROTOCOL[0]}-${REVENUE_LISTING_AUTHORITY_PROTOCOL[1]}-${REVENUE_LISTING_AUTHORITY_KEY_ID}`
  const curve = new Curve()
  const tweak = new BigNumber(sha256hmac(root.encode(true), toArray(invoice, 'utf8'))).umod(curve.n)
  const child = root.add(curve.g.mul(tweak))
  outputAssert(
    !child.isInfinity() && !child.getX().eq(root.getX()),
    'Degenerate listing child link'
  )
  return child.encode(true, 'hex') as string
}
