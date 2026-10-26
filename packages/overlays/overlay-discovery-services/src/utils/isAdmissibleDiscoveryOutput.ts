import { toUTF8Strict } from '@bsv/sdk/primitives/utils'
import { decodeCanonicalPushDrop, LockingScript } from '@bsv/sdk'
import { isAdvertisableURI } from './isAdvertisableURI.js'
import { isTokenSignatureCorrectlyLinked } from './isTokenSignatureCorrectlyLinked.js'
import { isValidTopicOrServiceName } from './isValidTopicOrServiceName.js'

export type DiscoveryProtocol = 'SHIP' | 'SLAP'

const discoveryNamePrefix: Record<DiscoveryProtocol, string> = {
  SHIP: 'tm_',
  SLAP: 'ls_'
}

const MAX_DISCOVERY_FIELD_BYTES = 4096
const MAX_DISCOVERY_PAYLOAD_BYTES = 8192

/**
 * Validates the shared SHIP/SLAP advertisement envelope while retaining each
 * protocol's topic-or-service prefix requirement.
 */
export async function isAdmissibleDiscoveryOutput(
  lockingScript: LockingScript,
  protocol: DiscoveryProtocol
): Promise<boolean> {
  try {
    const result = decodeCanonicalPushDrop(lockingScript, {
      fieldCount: 5,
      maximumFieldBytes: MAX_DISCOVERY_FIELD_BYTES,
      maximumPayloadBytes: MAX_DISCOVERY_PAYLOAD_BYTES
    })
    if (toUTF8Strict(result.fields[0]) !== protocol) return false
    if (!isAdvertisableURI(toUTF8Strict(result.fields[2]))) return false

    const advertisedName = toUTF8Strict(result.fields[3])
    if (!isValidTopicOrServiceName(advertisedName)) return false
    if (!advertisedName.startsWith(discoveryNamePrefix[protocol])) return false

    return await isTokenSignatureCorrectlyLinked(result.lockingPublicKey, result.fields)
  } catch {
    return false
  }
}
