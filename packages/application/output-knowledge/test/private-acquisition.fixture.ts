import {
  Beef,
  LockingScript,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  UnlockingScript,
  Utils,
  outputPacketDigest,
  type OutputChain,
  type OutputPaidLookupAcquire,
  type OutputPaidLookupChallenge
} from '@bsv/sdk'
import {
  advancePrivateAcquisitionProgress,
  createPrivateAcquisitionProgress,
  type PrivateAcquisitionProgress
} from '../src/private/PrivateAcquisitionProgress.js'

/** Real BRC-29/Atomic encoding, synthetic unproved inputs: lifecycle tests only. */
export async function acquisitionFixture(selectedChain?: OutputChain) {
  const chain = selectedChain ?? {
    network: 'acquisition-lifecycle-fixture',
    genesisHash: '66'.repeat(32)
  }
  const sellerWallet = new ProtoWallet(new PrivateKey(83)),
    buyerWallet = new ProtoWallet(new PrivateKey(84))
  const seller = (await sellerWallet.getPublicKey({ identityKey: true })).publicKey
  const buyer = (await buyerWallet.getPublicKey({ identityKey: true })).publicKey
  const prefix = 'cHVibGljLXF1b3Rl',
    suffix = 'cHVibGljLXBheW1lbnQ='
  const sellerPaymentKey = (
    await sellerWallet.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${prefix} ${suffix}`,
      counterparty: buyer,
      forSelf: true
    })
  ).publicKey
  const script = new P2PKH().lock(PublicKey.fromString(sellerPaymentKey).toAddress())
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
  const request: OutputPaidLookupAcquire = {
    version: 1,
    requestId: 'fixture-acquisition',
    service: 'ls_private',
    assetId: '33'.repeat(32),
    listing: { chain, txid: source.id('hex'), outputIndex: 0 },
    termsDigest: '44'.repeat(32),
    recipient: buyer,
    request: ''
  }
  const selected = { seller, rulesDigest: '55'.repeat(32) }
  const challenge: OutputPaidLookupChallenge = {
    version: 1,
    acquisitionId: outputPacketDigest('acquisition', {
      chain,
      seller,
      buyer,
      service: request.service,
      requestId: request.requestId
    }),
    requestDigest: outputPacketDigest('acquire-request', request),
    seller,
    buyer,
    assetId: request.assetId,
    termsDigest: request.termsDigest,
    satoshis: '100',
    derivationPrefix: prefix,
    acceptancePolicy: { kind: 'local-admission' },
    rulesDigest: selected.rulesDigest,
    payableUntil: '100',
    recoveryUntil: '86500'
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
  function initial(now = '1') {
    return createPrivateAcquisitionProgress(request, challenge, selected, now)
  }
  function pinned(now = '20') {
    return advancePrivateAcquisitionProgress(initial(), { type: 'pin', payment: payment() }, now)
  }
  function reserved(receivedAt = '20', now = '21') {
    const state = pinned(receivedAt)
    return advancePrivateAcquisitionProgress(
      state,
      {
        type: 'reserve-funding',
        candidateDigest: state.candidate!.digest,
        sellerPaymentKey,
        acceptance: {
          chain,
          txid: transaction.id('hex'),
          policy: challenge.acceptancePolicy,
          acceptedAt: '19'
        }
      },
      now
    )
  }
  function receipt(state: PrivateAcquisitionProgress) {
    const operation = state.funding!.operation
    return {
      operationId: operation.id,
      funding: operation.funding,
      seller,
      satoshis: operation.satoshis,
      evidence: { nativeReceipt: 'fixture-only' }
    }
  }
  function funded() {
    const state = reserved()
    return advancePrivateAcquisitionProgress(
      state,
      { type: 'wallet-accepted', receipt: receipt(state) },
      '22'
    )
  }
  return {
    seller,
    buyer,
    chain,
    sellerPaymentKey,
    script,
    transaction,
    request,
    selected,
    challenge,
    payment,
    initial,
    pinned,
    reserved,
    receipt,
    funded
  }
}
