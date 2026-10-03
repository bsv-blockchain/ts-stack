import {
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  parseOutputPurchaseEnvelope,
  Utils,
  type OutputPurchaseEnvelope
} from '@bsv/sdk'
import { encodeDeterministicCbor } from './cbor.js'
import {
  decodeLCHOverlayJSON,
  decodeUnverifiedLCHOverlayContext
} from './overlayAcquisitionCodec.js'
import { lchOverlayEntitlementLicense } from './overlayAcquisitionEntitlement.js'
import { lchAssert } from './errors.js'
import type { LCHValue } from './types.js'

/** Representation fingerprint only. A concrete domain records it in protected
 * immutable custody after independent purchase, release, License and key checks.
 * Signature/BRC78 randomness and non-rights issuance times may change; original
 * rights, recipient, transaction, settlement and release evidence cannot.
 */
export async function lchOverlayCovenantEntitlementDigest(
  input: OutputPurchaseEnvelope
): Promise<string> {
  const delivered = parseOutputPurchaseEnvelope(input),
    result = delivered.result
  lchAssert(
    result.status === 'delivered',
    'ERR_LCH_LICENSE',
    'A covenant entitlement requires complete delivered material'
  )
  const context = await decodeUnverifiedLCHOverlayContext(
      Uint8Array.from(decodeOutputBytes(result.potatoes.body.secret, 2097152)),
      'listing-covenant'
    ),
    potatoes = { ...result.potatoes.body }
  Reflect.deleteProperty(potatoes, 'secret')
  Reflect.deleteProperty(potatoes, 'issuedAt')
  const settlement = decodeLCHOverlayJSON(context.settlement)
  lchAssert(
    settlement !== null &&
      typeof settlement === 'object' &&
      !Array.isArray(settlement) &&
      Object.hasOwn(settlement, 'body'),
    'ERR_LCH_PAYMENT',
    'Covenant settlement packet is missing'
  )
  const fingerprint = {
    version: 1,
    delivered: new TextEncoder().encode(
      canonicalOutputJSON({ ...delivered, result: { ...result, potatoes } }, { bytes: 4194304 })
    ),
    license: lchOverlayEntitlementLicense(context.license),
    settlement: new TextEncoder().encode(
      canonicalOutputJSON((settlement as { body: unknown }).body)
    ),
    purchaseEvidence: context.purchaseEvidence!,
    evidence: context.evidence.map(entry => ({ type: entry.type, body: entry.object.body }))
  }
  return Utils.toHex(Hash.sha256(encodeDeterministicCbor(fingerprint as unknown as LCHValue)))
}
