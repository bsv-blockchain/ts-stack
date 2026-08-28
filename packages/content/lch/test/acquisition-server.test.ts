import { describe, expect, it, jest } from '@jest/globals'
import { LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk'
import {
  LCHBuyer,
  LCHPayee,
  LCHQuoteIssuer,
  MemoryPaymentLedger,
  WalletBRC77Signer,
  WalletPaymentReceiver,
  objectId,
  signObject,
  toHex,
  validateLicenseRequest,
  validatePaymentDemand,
  validatePaymentReceipt,
  validateQuote
} from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

describe('typed acquisition messages', () => {
  it('constructs a signed request and quote with exact demand totals and deadlines', async () => {
    const buyerSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(41)),
      random: length => bytes(1, length)
    })
    const issuerSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(42)),
      random: length => bytes(2, length)
    })
    const payeeSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(43)),
      random: length => bytes(3, length)
    })
    const request = await new LCHBuyer(buyerSigner, length => bytes(4, length)).createRequest({
      offerId: bytes(5, 32),
      assetId: bytes(6, 32),
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: bytes(7, 32),
      createdAt: 1_000
    })
    const requestId = await validateLicenseRequest(request)
    const demand = await new LCHPayee(payeeSigner, length => bytes(8, length)).createDemand({
      requestId,
      offerId: bytes(5, 32),
      dutyUid: 'urn:lch:duty:recording',
      buyer: buyerSigner.identityKey,
      endpoint: 'https://payee.example/lch',
      satoshis: 12,
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400
    })
    const quote = await new LCHQuoteIssuer(issuerSigner).createQuote({
      requestId,
      offerId: bytes(5, 32),
      assetId: bytes(6, 32),
      buyer: buyerSigner.identityKey,
      selection: { type: 'all' },
      demands: [demand],
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400
    })
    expect(quote.body.totalSatoshis).toBe(12n)
    expect(quote.body.recoveryUntil).toBe(88_400n)
    expect(await objectId('license-request', request.body)).toEqual(requestId)
    await expect(validateQuote(quote, request, issuerSigner.identityKey)).resolves.toEqual(
      await objectId('quote', quote.body)
    )
    const dishonestTotal = await signObject(
      'quote',
      { ...quote.body, totalSatoshis: 13 },
      issuerSigner
    )
    await expect(
      validateQuote(dishonestTotal, request, issuerSigner.identityKey)
    ).rejects.toMatchObject({ code: 'ERR_LCH_PAYMENT' })
  })

  it('rejects malformed request digests before signing', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(44))
    })
    await expect(
      new LCHBuyer(signer).createRequest({
        offerId: bytes(1, 32),
        assetId: bytes(2, 32),
        action: 'read',
        selection: { type: 'all' },
        acceptedPolicyDigest: bytes(3, 31),
        createdAt: 1
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_FRAMING' })
  })

  it('permits HTTP loopback only when that exact local origin is enumerated', async () => {
    const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(45))
    })
    const demand = await new LCHPayee(signer).createDemand({
      requestId: bytes(1, 32),
      offerId: bytes(2, 32),
      dutyUid: 'urn:lch:duty:local',
      buyer: bytes(3, 33),
      endpoint: 'http://127.0.0.1:4173/api/lch',
      satoshis: 1,
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400,
      allowInsecureLocalEndpoint: true
    })
    await expect(validatePaymentDemand(demand)).rejects.toMatchObject({
      code: 'ERR_LCH_ENDPOINT'
    })
    await expect(
      validatePaymentDemand(demand, undefined, {
        allowInsecureLocalOrigins: ['http://127.0.0.1:4173']
      })
    ).resolves.toBeInstanceOf(Uint8Array)
  })

  it('validates optional term acceptances, critical identifiers, and absolute endpoints', async () => {
    const buyerSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(46))
    })
    const payeeSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(47))
    })
    await expect(
      new LCHBuyer(buyerSigner).createRequest({
        offerId: bytes(1, 32),
        assetId: bytes(2, 32),
        action: 'play',
        selection: { type: 'all' },
        acceptedPolicyDigest: bytes(3, 32),
        acceptedHumanTermDigests: [bytes(4, 32)],
        createdAt: 1,
        critical: ['https://example.test/lch/critical-v1']
      })
    ).resolves.toBeDefined()
    await expect(
      new LCHBuyer(buyerSigner).createRequest({
        offerId: bytes(1, 32),
        assetId: bytes(2, 32),
        action: 'play',
        selection: { type: 'all' },
        acceptedPolicyDigest: bytes(3, 32),
        createdAt: 1,
        critical: ['https://example.test/repeated', 'https://example.test/repeated']
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_PROFILE_UNSUPPORTED' })
    await expect(
      new LCHBuyer(buyerSigner).createRequest({
        offerId: bytes(1, 32),
        assetId: bytes(2, 32),
        action: 'play',
        selection: { type: 'all' },
        acceptedPolicyDigest: bytes(3, 32),
        createdAt: 1,
        critical: ['not-an-absolute-identifier']
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_PROFILE_UNSUPPORTED' })

    const demand = await new LCHPayee(payeeSigner).createDemand({
      requestId: bytes(5, 32),
      offerId: bytes(6, 32),
      dutyUid: 'urn:lch:duty:endpoint',
      buyer: buyerSigner.identityKey,
      endpoint: 'https://payee.example/lch',
      satoshis: 1,
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400
    })
    const malformedEndpoint = await signObject(
      'payment-demand',
      { ...demand.body, endpoint: 'not-an-absolute-url' },
      payeeSigner
    )
    await expect(
      validatePaymentDemand(malformedEndpoint, undefined, {
        allowInsecureLocalOrigins: ['https://payee.example']
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_ENDPOINT' })
  })
})

describe('wallet-backed payee receiver', () => {
  it('preflights with the receiver clock and rejects malformed Atomic BEEF', async () => {
    const buyerSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(48))
    })
    const payeeSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(49))
    })
    const receiver = new WalletPaymentReceiver({
      wallet: {
        getPublicKey: async () => ({ publicKey: new PrivateKey(50).toPublicKey().toString() }),
        internalizeAction: async () => ({ accepted: true })
      } as never,
      signer: payeeSigner
    })
    const requestId = bytes(10, 32)
    const demand = await new LCHPayee(payeeSigner).createDemand({
      requestId,
      offerId: bytes(11, 32),
      dutyUid: 'urn:lch:duty:preflight',
      buyer: buyerSigner.identityKey,
      endpoint: 'https://payee.example/lch',
      satoshis: 1,
      expiresAt: 4_000_000_000,
      recoveryPeriodSeconds: 86_400
    })
    await expect(receiver.preflight(demand)).resolves.toBeUndefined()
    const delivery = await new LCHBuyer(buyerSigner).createPaymentDelivery({
      demandId: await objectId('payment-demand', demand.body),
      requestId,
      atomicBeef: bytes(12, 3),
      outputIndex: 0,
      derivationPrefix: demand.body.derivationPrefix as Uint8Array,
      derivationSuffix: bytes(13, 32)
    })
    await expect(receiver.receive(demand, delivery)).rejects.toThrow(/could not be parsed/u)
  })

  it('derives, verifies, internalizes, receipts, and idempotently redelivers one output', async () => {
    const buyerSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(51)),
      random: length => bytes(1, length)
    })
    const payeeSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(52)),
      random: length => bytes(2, length)
    })
    const payeePublicKey = new PrivateKey(53).toPublicKey()
    const internalizeAction = jest.fn(async () => ({ accepted: true, isMerge: false }))
    const receiverWallet = {
      getPublicKey: jest.fn(async () => ({ publicKey: payeePublicKey.toString() })),
      internalizeAction
    }
    const requestId = bytes(4, 32)
    const demand = await new LCHPayee(payeeSigner, length => bytes(5, length)).createDemand({
      requestId,
      offerId: bytes(6, 32),
      dutyUid: 'urn:lch:duty:master',
      buyer: buyerSigner.identityKey,
      endpoint: 'https://payee.example/lch',
      satoshis: 7,
      expiresAt: 2_000,
      recoveryPeriodSeconds: 86_400
    })
    const demandId = await objectId('payment-demand', demand.body)
    const lockingScript = new P2PKH().lock(payeePublicKey.toAddress()).toUint8Array()
    const transaction = new Transaction(
      1,
      [],
      [{ satoshis: 7, lockingScript: LockingScript.fromHex(toHex(lockingScript)) }]
    )
    const atomicBeef = Uint8Array.from(transaction.toAtomicBEEF(true))
    const delivery = await new LCHBuyer(buyerSigner).createPaymentDelivery({
      demandId,
      requestId,
      atomicBeef,
      outputIndex: 0,
      derivationPrefix: demand.body.derivationPrefix as Uint8Array,
      derivationSuffix: bytes(8, 32)
    })
    const receiver = new WalletPaymentReceiver({
      wallet: receiverWallet as never,
      signer: payeeSigner,
      ledger: new MemoryPaymentLedger(),
      now: () => 2_001n
    })
    const otherBuyer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(54))
    })
    const wrongBuyerDelivery = await new LCHBuyer(otherBuyer).createPaymentDelivery({
      demandId,
      requestId,
      atomicBeef,
      outputIndex: 0,
      derivationPrefix: demand.body.derivationPrefix as Uint8Array,
      derivationSuffix: bytes(8, 32)
    })
    await expect(receiver.receive(demand, wrongBuyerDelivery)).rejects.toMatchObject({
      code: 'ERR_LCH_PAYMENT'
    })
    const first = await receiver.receive(demand, delivery)
    const repeated = await receiver.receive(demand, delivery)
    expect(repeated).toBe(first)
    expect(internalizeAction).toHaveBeenCalledTimes(1)
    expect(internalizeAction.mock.calls[0]?.[0]).toMatchObject({
      outputs: [{ outputIndex: 0, protocol: 'wallet payment' }]
    })
    await expect(validatePaymentReceipt(first)).resolves.toBeInstanceOf(Uint8Array)
  })

  it('rejects a conflicting transaction for a claimed Demand', async () => {
    const buyerSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(61))
    })
    const payeeSigner = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(62))
    })
    const publicKey = new PrivateKey(63).toPublicKey()
    const receiver = new WalletPaymentReceiver({
      wallet: {
        getPublicKey: async () => ({ publicKey: publicKey.toString() }),
        internalizeAction: async () => ({ accepted: true })
      } as never,
      signer: payeeSigner,
      now: () => 100n
    })
    const requestId = bytes(1, 32)
    const demand = await new LCHPayee(payeeSigner, length => bytes(2, length)).createDemand({
      requestId,
      offerId: bytes(3, 32),
      dutyUid: 'urn:lch:duty:test',
      buyer: buyerSigner.identityKey,
      endpoint: 'https://payee.example/lch',
      satoshis: 9,
      expiresAt: 200,
      recoveryPeriodSeconds: 86_400
    })
    const demandId = await objectId('payment-demand', demand.body)
    const lockingScript = new P2PKH().lock(publicKey.toAddress())
    const makeDelivery = async (version: number) =>
      new LCHBuyer(buyerSigner).createPaymentDelivery({
        demandId,
        requestId,
        atomicBeef: Uint8Array.from(
          new Transaction(version, [], [{ satoshis: 9, lockingScript }]).toAtomicBEEF(true)
        ),
        outputIndex: 0,
        derivationPrefix: demand.body.derivationPrefix as Uint8Array,
        derivationSuffix: bytes(4, 32)
      })
    await receiver.receive(demand, await makeDelivery(1))
    await expect(receiver.receive(demand, await makeDelivery(2))).rejects.toMatchObject({
      code: 'ERR_LCH_PAYMENT'
    })
  })
})
