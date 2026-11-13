import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  UnlockingScript,
  Utils
} from '../../../mod.js'
import type { OutputPaidLookupChallenge } from '../OutputPaidLookupProtocol.js'

export async function fundingFixture() {
  const sellerWallet = new ProtoWallet(new PrivateKey(83)),
    buyerWallet = new ProtoWallet(new PrivateKey(84))
  const seller = (await sellerWallet.getPublicKey({ identityKey: true })).publicKey
  const buyer = (await buyerWallet.getPublicKey({ identityKey: true })).publicKey
  const prefix = 'cHVibGljLXF1b3Rl',
    suffix = 'cHVibGljLXBheW1lbnQ='
  const derivation = {
    protocolID: [2, '3241645161d8'] as [2, string],
    keyID: `${prefix} ${suffix}`
  }
  const sellerPaymentKey = (
    await sellerWallet.getPublicKey({ ...derivation, counterparty: buyer, forSelf: true })
  ).publicKey
  const payerSelectedKey = (await buyerWallet.getPublicKey({ ...derivation, counterparty: seller }))
    .publicKey
  if (sellerPaymentKey !== payerSelectedKey) throw new Error('BRC-29 public derivations disagree')
  const script = new P2PKH().lock(PublicKey.fromString(sellerPaymentKey).toAddress())
  // Structural synthetic data only: this source has no selected-chain mining proof.
  const source = new Transaction(
    1,
    [],
    [{ satoshis: 1000, lockingScript: LockingScript.fromHex('51') }],
    0
  )
  const transaction = new Transaction(
    1,
    [
      {
        sourceTXID: source.id('hex'),
        sourceOutputIndex: 0,
        sourceTransaction: source,
        unlockingScript: UnlockingScript.fromHex(''),
        sequence: 0xffffffff
      }
    ],
    [
      { satoshis: 900, lockingScript: LockingScript.fromHex('51') },
      { satoshis: 100, lockingScript: script }
    ],
    0
  )
  const challenge: OutputPaidLookupChallenge = {
    version: 1,
    acquisitionId: '11'.repeat(32),
    requestDigest: '22'.repeat(32),
    seller,
    buyer,
    assetId: '33'.repeat(32),
    termsDigest: '44'.repeat(32),
    satoshis: '100',
    derivationPrefix: prefix,
    acceptancePolicy: { kind: 'local-admission' },
    rulesDigest: '55'.repeat(32),
    payableUntil: '100',
    recoveryUntil: '86500'
  }
  const selected = {
    chain: { network: 'payment-structure-fixture', genesisHash: '66'.repeat(32) },
    sellerPaymentKey
  }
  function payment(tx = transaction) {
    const beef = new Beef()
    beef.mergeTransaction(tx)
    return {
      derivationPrefix: prefix,
      derivationSuffix: suffix,
      transaction: Utils.toBase64(beef.toBinaryAtomic(tx.id('hex')))
    }
  }
  return { source, transaction, challenge, selected, payment, script }
}
