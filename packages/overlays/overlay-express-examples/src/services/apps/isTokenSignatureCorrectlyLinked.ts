import { PublicKey, ProtoWallet, PubKeyHex, WalletProtocol } from '@bsv/sdk'

/**
 * Checks that the BRC-48 locking key and the signature are valid and linked to the claimed identity key.
 * @param lockingPublicKey - The public key used in the output's locking script.
 * @param fields - The fields of the PushDrop token for the UHRP advertisement.
 * @returns True if the token's signature is properly linked to the claimed identity key, false otherwise.
 */
export const isTokenSignatureCorrectlyLinked = async (
    lockingPublicKey: PublicKey,
    publisher: PubKeyHex,
    fields: number[][]
): Promise<boolean> => {
    // The signature is the last field, which needs to be removed for verification
    const signature = fields.pop() as number[]

    // The protocol is in the first field
    const protocolID: WalletProtocol = [1, 'metanet apps']

    // First, we ensure that the signature over the data is valid for the claimed identity key.
    const data = fields.reduce((a, e) => [...a, ...e], [])
    const anyoneWallet = new ProtoWallet('anyone')
    try {
        const { valid } = await anyoneWallet.verifySignature({
            data,
            signature,
            counterparty: publisher,
            protocolID,
            keyID: '1'
        })
        if (!valid) {
            return false
        }
    } catch (e) {
        return false
    }

    // Then, we ensure that the locking public key matches the correct derived child.
    const { publicKey: expectedLockingPublicKey } = await anyoneWallet.getPublicKey({
        counterparty: publisher,
        protocolID,
        keyID: '1'
    })
    return expectedLockingPublicKey === lockingPublicKey.toString()
}
