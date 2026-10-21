import {
  canonicalOutputJSON,
  signOutputPacket,
  type OutputDigestDomain,
  type OutputSignedPacket,
  type PrivateKey
} from '@bsv/sdk'

// Public synthetic fixtures only. Reuse identical real signature bytes, returning
// a fresh body every time. Production authentication and verification still run;
// changed terms, signer or packet domain always require a new real signature.
const packets = new Map<string, OutputSignedPacket<unknown>>()
export function signPurchaseFixturePacket<T>(
  type: OutputDigestDomain,
  body: T,
  key: PrivateKey
): OutputSignedPacket<T> {
  const id = canonicalOutputJSON([type, key.toString(), body])
  let packet = packets.get(id)
  if (!packet) {
    packet = signOutputPacket(type, body, key)
    if (packets.size >= 256) packets.delete(packets.keys().next().value!)
    packets.set(id, packet)
  }
  return structuredClone(packet) as OutputSignedPacket<T>
}
