import { verifyKeyLinkage, linkageControlsPubKeyHash } from '../verifyKeyLinkage.js'
import { ProtoWallet, PrivateKey, Hash, Utils, WalletProtocol } from '@bsv/sdk'

describe('verifyKeyLinkage', () => {
  const protocolID: WalletProtocol = [2, 'mandala token']
  const keyID = 'token-1'

  const makeWallet = (priv = PrivateKey.fromRandom()) => ({ priv, wallet: new ProtoWallet(priv) })

  it('recovers the controlling identity key and derived pubKeyHash from a real reveal', async () => {
    const prover = makeWallet()      // the sender, who reveals linkage
    const verifier = makeWallet()    // the overlay
    const receiver = makeWallet()    // counterparty the key was derived for

    const { publicKey: verifierKey } = await verifier.wallet.getPublicKey({ identityKey: true })
    const { publicKey: receiverKey } = await receiver.wallet.getPublicKey({ identityKey: true })

    // The key the sender derives FOR the receiver — what the output is locked to.
    const { publicKey: derivedKey } = await prover.wallet.getPublicKey({
      protocolID, keyID, counterparty: receiverKey
    })

    const linkage = await prover.wallet.revealSpecificKeyLinkage({
      counterparty: receiverKey, verifier: verifierKey, protocolID, keyID
    })

    const result = await verifyKeyLinkage(linkage as any, verifier.wallet as any)
    expect(result.identityKey).toBe(receiverKey)
    expect(result.derivedKey).toBe(derivedKey)

    const expectedHash = Hash.hash160(Utils.toArray(derivedKey, 'hex'))
    expect(result.pubKeyHash).toEqual(expectedHash)
    expect(await linkageControlsPubKeyHash(linkage as any, verifier.wallet as any, expectedHash)).toBe(true)
    expect(await linkageControlsPubKeyHash(linkage as any, verifier.wallet as any, new Array(20).fill(0))).toBe(false)
  })
})
