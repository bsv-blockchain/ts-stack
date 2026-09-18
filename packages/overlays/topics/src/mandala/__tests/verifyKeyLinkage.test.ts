import { verifyKeyLinkage, verifyInputKeyLinkage, linkageControlsPubKeyHash } from '../verifyKeyLinkage.js'
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
    expect(await linkageControlsPubKeyHash(linkage as any, verifier.wallet as any, Array.from({ length: 20 }, () => 0))).toBe(false)
  })

  it('an INPUT linkage names the prover and reconstructs the prover’s own child key', async () => {
    const spender = makeWallet()     // the prover: whoever the coin was locked to
    const payer = makeWallet()       // the counterparty the child key was derived against
    const verifier = makeWallet()

    const { publicKey: spenderKey } = await spender.wallet.getPublicKey({ identityKey: true })
    const { publicKey: payerKey } = await payer.wallet.getPublicKey({ identityKey: true })
    const { publicKey: verifierKey } = await verifier.wallet.getPublicKey({ identityKey: true })
    // The key the spender's coin is locked to: its own child key for this counterparty.
    const { publicKey: ownChildKey } = await spender.wallet.getPublicKey({
      protocolID, keyID, counterparty: payerKey, forSelf: true
    })
    const linkage = await spender.wallet.revealSpecificKeyLinkage({
      counterparty: payerKey, verifier: verifierKey, protocolID, keyID
    })

    const asInput = await verifyInputKeyLinkage(linkage as any, verifier.wallet as any)
    expect(asInput.identityKey).toBe(spenderKey)
    expect(asInput.derivedKey).toBe(ownChildKey)
    expect(asInput.pubKeyHash).toEqual(Hash.hash160(Utils.toArray(ownChildKey, 'hex')))

    // Read as an OUTPUT linkage the same reveal names the payer and a different key.
    const asOutput = await verifyKeyLinkage(linkage as any, verifier.wallet as any)
    expect(asOutput.identityKey).toBe(payerKey)
    expect(asOutput.derivedKey).not.toBe(ownChildKey)
  })
})
