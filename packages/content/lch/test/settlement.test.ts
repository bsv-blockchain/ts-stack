import { describe, expect, it } from '@jest/globals'
import { LockingScript, PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk'
import {
  LCHBuyer,
  LCHPayee,
  LCHSettlementService,
  LCH_SETTLEMENT_PROFILES,
  LCH_TRANSACTION_EVIDENCE_POLICIES,
  WalletAuthorizedOutputPayee,
  WalletBRC77Signer,
  objectId,
  signObject,
  toHex,
  validateAuthorizedOutputEvidence,
  validatePaymentAuthorization,
  validatePaymentDeliveryRetrieval,
  type SignedObject
} from '../src/index.js'

describe('authorized-output settlement profile', () => {
  it('releases a verifiable proof bundle while the Payee wallet is unavailable', async () => {
    const fixture = await authorizedFixture()
    await expect(
      validateAuthorizedOutputEvidence(fixture.bundle, fixture.demand, fixture.atomicBeef)
    ).resolves.toEqual(fixture.demandId)
    const retrieval = await new LCHPayee(fixture.payeeSigner).createDeliveryRetrieval({
      authorizationId: fixture.authorizationId,
      requestedAt: 2_001,
      nonce: new Uint8Array(16).fill(6)
    })
    await expect(
      validatePaymentDeliveryRetrieval(retrieval, fixture.bundle.authorization)
    ).resolves.toEqual(await objectId('payment-delivery-retrieval', retrieval.body))

    const lowEvidence = await signObject(
      'transaction-evidence',
      {
        version: 1,
        authorizationId: fixture.authorizationId,
        txid: Uint8Array.from(fixture.transaction.id('array')),
        provider: fixture.providerSigner.identityKey,
        state: 'broadcast',
        policy: LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance,
        observedAt: 1_050
      },
      fixture.providerSigner
    )
    await expect(
      validateAuthorizedOutputEvidence(
        { ...fixture.bundle, transactionEvidence: lowEvidence },
        fixture.demand,
        fixture.atomicBeef
      )
    ).rejects.toThrow(/minimum state/u)

    const shortRetention = await new LCHSettlementService(
      fixture.providerSigner
    ).createDeliveryAcknowledgement({
      authorizationId: fixture.authorizationId,
      deliveryId: await objectId('payment-delivery', fixture.bundle.delivery.body),
      demandId: fixture.demandId,
      requestId: fixture.requestId,
      payee: fixture.payeeSigner.identityKey,
      storedAt: 1_050,
      availableUntil: 2_001,
      retrievalEndpoint: 'https://availability.test/retrieve'
    })
    await expect(
      validateAuthorizedOutputEvidence(
        { ...fixture.bundle, deliveryAcknowledgement: shortRetention },
        fixture.demand,
        fixture.atomicBeef
      )
    ).rejects.toThrow(/recovery deadline/u)
  })

  it('rejects a substituted output and an unauthorized evidence provider', async () => {
    const fixture = await authorizedFixture()
    const wrongTransaction = new Transaction(
      1,
      [],
      [{ satoshis: 7, lockingScript: LockingScript.fromHex('51') }]
    )
    const wrongBeef = Uint8Array.from(wrongTransaction.toAtomicBEEF(true))
    await expect(
      validateAuthorizedOutputEvidence(fixture.bundle, fixture.demand, wrongBeef)
    ).rejects.toThrow(/Completion Atomic BEEF does not match/u)

    const otherProvider = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(215))
    })
    const foreignEvidence = await new LCHSettlementService(otherProvider).createTransactionEvidence(
      {
        authorizationId: fixture.authorizationId,
        txid: Uint8Array.from(fixture.transaction.id('array')),
        state: 'accepted',
        policy: LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance,
        observedAt: 1_050
      }
    )
    await expect(
      validateAuthorizedOutputEvidence(
        { ...fixture.bundle, transactionEvidence: foreignEvidence },
        fixture.demand,
        fixture.atomicBeef
      )
    ).rejects.toThrow(/Evidence provider does not match/u)
  })

  it('binds one idempotent Authorization to the exact Demand and expiry', async () => {
    const fixture = await authorizedFixture()
    await expect(
      validatePaymentAuthorization(fixture.bundle.authorization, fixture.demand, 1_999)
    ).resolves.toEqual(fixture.authorizationId)
    await expect(
      validatePaymentAuthorization(fixture.bundle.authorization, fixture.demand, 2_000)
    ).rejects.toThrow(/not currently valid/u)
    expect(await fixture.authorizer.authorize(fixture.demand, fixture.policy)).toEqual(
      fixture.bundle.authorization
    )
  })
})

async function authorizedFixture(): Promise<{
  demand: SignedObject
  demandId: Uint8Array
  requestId: Uint8Array
  authorizationId: Uint8Array
  atomicBeef: Uint8Array
  transaction: Transaction
  bundle: {
    authorization: SignedObject
    delivery: SignedObject
    transactionEvidence: SignedObject
    deliveryAcknowledgement: SignedObject
  }
  authorizer: WalletAuthorizedOutputPayee
  policy: Parameters<WalletAuthorizedOutputPayee['authorize']>[1]
  payeeSigner: WalletBRC77Signer
  providerSigner: WalletBRC77Signer
}> {
  const buyerSigner = await WalletBRC77Signer.create({
    wallet: new ProtoWallet(new PrivateKey(211))
  })
  const payeeWallet = new ProtoWallet(new PrivateKey(212))
  const payeeSigner = await WalletBRC77Signer.create({ wallet: payeeWallet })
  const providerSigner = await WalletBRC77Signer.create({
    wallet: new ProtoWallet(new PrivateKey(213))
  })
  const requestId = new Uint8Array(32).fill(1)
  const demand = await new LCHPayee(payeeSigner).createDemand({
    requestId,
    offerId: new Uint8Array(32).fill(2),
    dutyUid: 'urn:lch:duty:drummer',
    buyer: buyerSigner.identityKey,
    endpoint: 'https://drummer.test/payments',
    satoshis: 7,
    expiresAt: 2_000,
    recoveryPeriodSeconds: 86_400,
    settlementProfile: LCH_SETTLEMENT_PROFILES.authorizedOutput
  })
  const demandId = await objectId('payment-demand', demand.body)
  const authorizer = new WalletAuthorizedOutputPayee({
    wallet: payeeWallet,
    signer: payeeSigner,
    now: () => 1_000n,
    random: length => new Uint8Array(length).fill(3)
  })
  const policy = {
    evidenceProvider: providerSigner.identityKey,
    evidenceEndpoint: 'https://processor.test/evidence',
    deliveryProvider: providerSigner.identityKey,
    deliveryEndpoint: 'https://availability.test/store',
    retrievalEndpoint: 'https://availability.test/retrieve'
  }
  const authorization = await authorizer.authorize(demand, policy)
  const authorizationId = await objectId('payment-authorization', authorization.body)
  const transaction = new Transaction(
    1,
    [],
    [
      {
        satoshis: 7,
        lockingScript: LockingScript.fromHex(toHex(authorization.body.lockingScript as Uint8Array))
      }
    ]
  )
  const atomicBeef = Uint8Array.from(transaction.toAtomicBEEF(true))
  const delivery = await new LCHBuyer(buyerSigner).createPaymentDelivery({
    demandId,
    requestId,
    atomicBeef,
    outputIndex: 0,
    derivationPrefix: authorization.body.derivationPrefix as Uint8Array,
    derivationSuffix: authorization.body.derivationSuffix as Uint8Array
  })
  const service = new LCHSettlementService(providerSigner)
  const transactionEvidence = await service.createTransactionEvidence({
    authorizationId,
    txid: Uint8Array.from(transaction.id('array')),
    state: 'accepted',
    policy: LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance,
    observedAt: 1_050
  })
  const deliveryAcknowledgement = await service.createDeliveryAcknowledgement({
    authorizationId,
    deliveryId: await objectId('payment-delivery', delivery.body),
    demandId,
    requestId,
    payee: payeeSigner.identityKey,
    storedAt: 1_050,
    availableUntil: 88_400,
    retrievalEndpoint: 'https://availability.test/retrieve'
  })
  return {
    demand,
    demandId,
    requestId,
    authorizationId,
    atomicBeef,
    transaction,
    bundle: { authorization, delivery, transactionEvidence, deliveryAcknowledgement },
    authorizer,
    policy,
    payeeSigner,
    providerSigner
  }
}
