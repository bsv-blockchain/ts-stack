import { toHex, toUTF8Strict } from '@bsv/sdk/primitives/utils'
import { PublicKey, ProtoWallet } from '@bsv/sdk' /**
 * Checks that the BRC-48 locking key and the signature are valid and linked to the claimed identity key.
 * @param lockingPublicKey - The public key used in the output's locking script.
 * @param fields - The fields of the PushDrop token for the SHIP or SLAP advertisement.
 * @returns True if the token's signature is properly linked to the claimed identity key, false otherwise.
 */
export const isTokenSignatureCorrectlyLinked = async (
  lockingPublicKey: PublicKey,
  fields: number[][]
): Promise<boolean> => {
  try {
    if (!Array.isArray(fields) || fields.length !== 5) return false
    for (let index = 0; index < fields.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(fields, index) || !Array.isArray(fields[index])) {
        return false
      }
    }

    // Verification must not consume or otherwise mutate the caller's decoded token.
    const dataFields = fields.slice(0, -1)
    const signature = fields.at(-1)!
    const protocol = toUTF8Strict(dataFields[0])
    if (protocol !== 'SHIP' && protocol !== 'SLAP') return false
    const protocolID: [2, string] = [
      2,
      protocol === 'SHIP' ? 'service host interconnect' : 'service lookup availability'
    ]
    const identityKey = toHex(dataFields[1])
    if (PublicKey.fromString(identityKey).toString() !== identityKey) return false

    // First, ensure the signature over the data is valid for the claimed identity key.
    const anyoneWallet = new ProtoWallet('anyone')
    const { valid } = await anyoneWallet.verifySignature({
      data: dataFields.flat(),
      signature,
      counterparty: identityKey,
      protocolID,
      keyID: '1'
    })
    if (valid !== true) {
      return false
    }

    // Then, ensure the locking public key is the identity's expected BRC-48 child.
    const { publicKey: expectedLockingPublicKey } = await anyoneWallet.getPublicKey({
      counterparty: identityKey,
      protocolID,
      keyID: '1'
    })
    return expectedLockingPublicKey === lockingPublicKey.toString()
  } catch {
    // Malformed keys, fields, signatures, or wallet results are invalid tokens.
    return false
  }
}
