import { isTokenSignatureCorrectlyLinked } from '../isTokenSignatureCorrectlyLinked'
import { ProtoWallet, PrivateKey, Utils, PublicKey } from '@bsv/sdk'

describe('isTokenSignatureCorrectlyLinked', () => {
    it('Validates a correctly-linked signature', async () => {
        const signerKey = new PrivateKey(42)
        const signerWallet = new ProtoWallet(signerKey)
        const { publicKey: signerIdentityKey } = await signerWallet.getPublicKey({ identityKey: true })
        const fields = [
            Utils.toArray('SHIP', 'utf8'),
            Utils.toArray(signerIdentityKey, 'hex'),
            Utils.toArray('https://domain.com', 'utf8'),
            Utils.toArray('tm_meter', 'utf8')
        ]
        const data = fields.reduce((a, e) => [...a, ...e], [])
        const { signature } = await signerWallet.createSignature({
            protocolID: [2, 'service host interconnect'],
            keyID: '1',
            counterparty: 'anyone',
            data
        })
        fields.push(signature)
        const { publicKey } = await signerWallet.getPublicKey({
            protocolID: [2, 'service host interconnect'],
            keyID: '1',
            counterparty: 'anyone',
            forSelf: true
        })
        const valid = await isTokenSignatureCorrectlyLinked(PublicKey.fromString(publicKey), fields)
        expect(valid).toBe(true)
    })
    it('Fails to validate a signature over data that is simply incorrect', async () => {
        const signerKey = new PrivateKey(42)
        const signerWallet = new ProtoWallet(signerKey)
        const { publicKey: signerIdentityKey } = await signerWallet.getPublicKey({ identityKey: true })
        const fields = [
            Utils.toArray('SHIP', 'utf8'),
            Utils.toArray(signerIdentityKey, 'hex'),
            Utils.toArray('https://domain.com', 'utf8'),
            Utils.toArray('tm_meter', 'utf8')
        ]
        const data = fields.reduce((a, e) => [...a, ...e], [])
        const { signature } = await signerWallet.createSignature({
            protocolID: [2, 'service host interconnect'],
            keyID: '1',
            counterparty: 'anyone',
            data
        })
        fields.push(signature)
        const { publicKey } = await signerWallet.getPublicKey({
            protocolID: [2, 'service host interconnect'],
            keyID: '1',
            counterparty: 'anyone',
            forSelf: true
        })
        // Tamper with fields
        fields[0] = Utils.toArray('SLAP', 'utf8')
        const valid = await isTokenSignatureCorrectlyLinked(PublicKey.fromString(publicKey), fields)
        expect(valid).toBe(false)
    })
    it('Even if the signature is facially correct, fails if the claimed identity key is incorrect', async () => {
        const signerKey = new PrivateKey(42)
        const signerWallet = new ProtoWallet(signerKey)
        const taylorSwiftKey = new PrivateKey(69) // No one is allowed to pretend to be Taylor Swift if they are not.
        const taylorSwiftWallet = new ProtoWallet(taylorSwiftKey)
        const { publicKey: taylorSwiftIdentityKey } = await taylorSwiftWallet.getPublicKey({ identityKey: true })
        const fields = [
            Utils.toArray('SHIP', 'utf8'),
            Utils.toArray(taylorSwiftIdentityKey, 'hex'),
            Utils.toArray('https://domain.com', 'utf8'),
            Utils.toArray('tm_meter', 'utf8')
        ]
        const data = fields.reduce((a, e) => [...a, ...e], [])
        const { signature } = await signerWallet.createSignature({
            protocolID: [2, 'service host interconnect'],
            keyID: '1',
            counterparty: 'anyone',
            data
        }) // Signer signature is still "valid", but they're pretending to be someone they're not in field 1 of their data.
        fields.push(signature)
        const { publicKey } = await signerWallet.getPublicKey({
            protocolID: [2, 'service host interconnect'],
            keyID: '1',
            counterparty: 'anyone',
            forSelf: true
        }) // Signing key is derived from the signer wallet and not Taylor Swift, because they are trying to fool us.
        const valid = await isTokenSignatureCorrectlyLinked(PublicKey.fromString(publicKey), fields)
        expect(valid).toBe(false) // Not allowed.
    })
})
