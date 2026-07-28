import { LockingScript, PushDrop, Utils } from '@bsv/sdk'
import { isAdvertisableURI } from './isAdvertisableURI.js'
import { isTokenSignatureCorrectlyLinked } from './isTokenSignatureCorrectlyLinked.js'
import { isValidTopicOrServiceName } from './isValidTopicOrServiceName.js'

export type DiscoveryProtocol = 'SHIP' | 'SLAP'

const discoveryNamePrefix: Record<DiscoveryProtocol, string> = {
  SHIP: 'tm_',
  SLAP: 'ls_'
}

/**
 * Validates the shared SHIP/SLAP advertisement envelope while retaining each
 * protocol's topic-or-service prefix requirement.
 */
export async function isAdmissibleDiscoveryOutput(
  lockingScript: LockingScript,
  protocol: DiscoveryProtocol
): Promise<boolean> {
  const result = PushDrop.decode(lockingScript)
  if (result.fields.length !== 5) return false
  if (Utils.toUTF8(result.fields[0]) !== protocol) return false
  if (!isAdvertisableURI(Utils.toUTF8(result.fields[2]))) return false

  const advertisedName = Utils.toUTF8(result.fields[3])
  if (!isValidTopicOrServiceName(advertisedName)) return false
  if (!advertisedName.startsWith(discoveryNamePrefix[protocol])) return false

  return await isTokenSignatureCorrectlyLinked(result.lockingPublicKey, result.fields)
}
