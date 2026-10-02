import {
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  Utils,
  type OutputPaidLookupAcquired
} from '@bsv/sdk'
import { snapshotLCHRecord, snapshotSignedObject } from './boundary.js'
import { encodeDeterministicCbor } from './cbor.js'
import {
  decodeLCHOverlayJSON,
  decodeUnverifiedLCHOverlayContext
} from './overlayAcquisitionCodec.js'
import { lchAssert } from './errors.js'
import type { LCHValue } from './types.js'

/** Representation fingerprint, never an authorization verdict by itself.
 * It is useful only after the complete acquisition has been independently
 * verified and this value committed to protected immutable local custody.
 * Equivalent reissue may vary signature/BRC-78 randomness and non-rights
 * issuedAt; accepted Agreement bytes, key commitments, subject, selection,
 * historical settlement and complete payment/release evidence cannot change.
 */
export async function lchOverlayPaidEntitlementDigest(
  input: OutputPaidLookupAcquired
): Promise<string> {
  const delivered = JSON.parse(
    canonicalOutputJSON(input, { bytes: 4194304 })
  ) as OutputPaidLookupAcquired
  lchAssert(
    delivered.status === 'delivered' && delivered.result !== undefined,
    'ERR_LCH_LICENSE',
    'An entitlement fingerprint requires complete delivered material'
  )
  const context = await decodeUnverifiedLCHOverlayContext(
      Uint8Array.from(decodeOutputBytes(delivered.result.context, 2097152)),
      'paid-lookup'
    ),
    license = snapshotSignedObject(context.license),
    body = license.body,
    result = { ...delivered.result }
  Reflect.deleteProperty(result, 'context')
  Reflect.deleteProperty(body, 'issuedAt')
  lchAssert(Array.isArray(body.keyGrants), 'ERR_LCH_KEY', 'Missing key grants')
  body.keyGrants = body.keyGrants.map(value => {
    const grant = snapshotLCHRecord(value, 'Entitlement key grant')
    lchAssert(
      grant.payload instanceof Uint8Array && grant.payload.length > 102,
      'ERR_LCH_KEY',
      'Key grant payload is truncated'
    )
    const payload = grant.payload
    Reflect.deleteProperty(grant, 'payload')
    return { ...grant, sender: payload.slice(4, 37), recipient: payload.slice(37, 70) }
  })
  const settlement = decodeLCHOverlayJSON(context.settlement)
  lchAssert(
    settlement !== null &&
      typeof settlement === 'object' &&
      !Array.isArray(settlement) &&
      Object.hasOwn(settlement, 'body'),
    'ERR_LCH_PAYMENT',
    'Settlement packet is missing'
  )
  const fingerprint = {
    version: 1,
    delivered: new TextEncoder().encode(
      canonicalOutputJSON({ ...delivered, result }, { bytes: 4194304 })
    ),
    license: body,
    settlement: new TextEncoder().encode(
      canonicalOutputJSON((settlement as { body: unknown }).body)
    ),
    paymentEvidence: context.paymentEvidence!,
    evidence: context.evidence.map(entry => ({ type: entry.type, body: entry.object.body }))
  }
  return Utils.toHex(Hash.sha256(encodeDeterministicCbor(fingerprint as unknown as LCHValue)))
}
