import { describe, expect, it } from '@jest/globals'
import {
  LockingScript,
  PrivateKey,
  ProtoWallet,
  Transaction,
  type AtomicBEEF,
  type CreateActionArgs,
  type WalletInterface
} from '@bsv/sdk'
import {
  LCHHttpServer,
  LCHMultipayBuyer,
  LCHPayee,
  LCHQuoteIssuer,
  WalletBRC77Signer,
  objectId,
  signObject,
  toHex,
  validateLicenseRequest,
  type PaymentCompletion,
  type SignedObject
} from '../src/index.js'

const bytes = (value: number, length: number): Uint8Array => new Uint8Array(length).fill(value)

describe('recovery-safe multipay buyer', () => {
  it('preflights, funds once, delivers every output, completes, and recovers the License', async () => {
    const buyerWallet = actionWallet(121)
    const issuerSigner = await walletSigner(122)
    const payees = await Promise.all(
      [
        { key: 123, satoshis: 7, dutyUid: 'urn:lch:duty:recording' },
        { key: 124, satoshis: 5, dutyUid: 'urn:lch:duty:composition' }
      ].map(async item => ({
        ...item,
        signer: await walletSigner(item.key)
      }))
    )
    const endpoint = 'https://multipay.test/lch'
    const offerId = bytes(1, 32)
    const assetId = bytes(2, 32)
    const demands = new Map<string, { demand: SignedObject; payee: (typeof payees)[number] }>()
    let issuedLicense: SignedObject | undefined
    const server = new LCHHttpServer({
      handlers: {
        preflightLicense: async request => {
          await validateLicenseRequest(request)
        },
        quote: async request => {
          const requestId = await validateLicenseRequest(request)
          const buyerIdentity = request.body.buyer as Uint8Array
          const signedDemands = await Promise.all(
            payees.map(async payee => {
              const demand = await new LCHPayee(payee.signer).createDemand({
                requestId,
                offerId,
                dutyUid: payee.dutyUid,
                buyer: buyerIdentity,
                endpoint,
                satoshis: payee.satoshis,
                expiresAt: 2_000,
                recoveryPeriodSeconds: 86_400
              })
              demands.set(toHex(await objectId('payment-demand', demand.body)), { demand, payee })
              return demand
            })
          )
          return new LCHQuoteIssuer(issuerSigner).createQuote({
            requestId,
            offerId,
            assetId,
            buyer: buyerIdentity,
            selection: { type: 'all' },
            demands: signedDemands,
            expiresAt: 2_000,
            recoveryPeriodSeconds: 86_400
          })
        },
        preflightDemand: async () => undefined,
        paymentDelivery: async delivery => {
          const demandId = delivery.body.demandId as Uint8Array
          const runtime = demands.get(toHex(demandId))
          if (runtime === undefined) throw new Error('unknown Demand')
          const transaction = Transaction.fromAtomicBEEF(delivery.body.atomicBeef as AtomicBEEF)
          return new LCHPayee(runtime.payee.signer).createReceipt({
            demandId,
            requestId: delivery.body.requestId as Uint8Array,
            txid: Uint8Array.from(transaction.id('array')),
            outputIndex: delivery.body.outputIndex as number,
            satoshis: runtime.payee.satoshis,
            receivedAt: 1_100
          })
        },
        complete: async (completion: PaymentCompletion) => {
          issuedLicense = await signObject(
            'license',
            {
              version: 1,
              requestId: await objectId('license-request', completion.request.body),
              subject: completion.request.body.buyer!
            },
            issuerSigner
          )
          return issuedLicense
        },
        recover: async () => issuedLicense
      }
    })
    const buyer = await LCHMultipayBuyer.create(buyerWallet.wallet, {
      now: () => 1_000n,
      endpointPolicy: {
        allowLocalOrigins: ['https://multipay.test'],
        connect: async (url, init) => server.handle(new Request(url, init))
      }
    })
    const request = await buyer.createRequest({
      offerId,
      assetId,
      action: 'play',
      selection: { type: 'all' },
      acceptedPolicyDigest: bytes(3, 32),
      createdAt: 1_000
    })
    const plan = await buyer.quote(endpoint, request, issuerSigner.identityKey)
    expect(plan.totalSatoshis).toBe(12n)

    const payment = await buyer.createPayment(plan)
    expect(buyerWallet.createdActions()).toBe(1)
    expect(payment.deliveries).toHaveLength(2)
    const receipts = await Promise.all(
      payment.deliveries.map(delivery => buyer.deliver(payment, delivery))
    )
    const license = await buyer.complete(payment, receipts)
    await expect(buyer.recover(endpoint, plan.requestId)).resolves.toEqual(license)
    await expect(buyer.complete(payment, receipts.slice(1))).rejects.toThrow(
      /one Receipt per Delivery/u
    )
    await expect(buyer.complete(payment, [receipts[0]!, receipts[0]!])).rejects.toThrow(
      /unexpected or repeated Receipt/u
    )
    expect(buyerWallet.createdActions()).toBe(1)
  })

  it('refuses to fund at the signed Quote expiry boundary', async () => {
    const signer = await walletSigner(131)
    const buyer = new LCHMultipayBuyer(actionWallet(132).wallet, signer, {
      now: () => 2_000n
    })
    await expect(
      buyer.createPayment({
        request: await signObject('license-request', { version: 1 }, signer),
        requestId: bytes(1, 32),
        quote: await signObject('quote', { version: 1 }, signer),
        demands: [],
        issuer: signer.identityKey,
        endpoint: 'https://multipay.test/lch',
        totalSatoshis: 0n,
        expiresAt: 2_000n,
        recoveryUntil: 3_000n
      })
    ).rejects.toThrow(/expired before transaction creation/u)
  })
})

async function walletSigner(privateKey: number): Promise<WalletBRC77Signer> {
  return WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(privateKey)) })
}

function actionWallet(privateKey: number): {
  wallet: WalletInterface
  createdActions(): number
} {
  const proto = new ProtoWallet(new PrivateKey(privateKey))
  let actions = 0
  const wallet = new Proxy(proto as unknown as WalletInterface, {
    get(target, property, receiver) {
      if (property === 'createAction')
        return async (args: CreateActionArgs) => {
          actions += 1
          const outputs = (args.outputs ?? [])
            .map(output => ({
              satoshis: output.satoshis,
              lockingScript: LockingScript.fromHex(output.lockingScript)
            }))
            .reverse()
          const transaction = new Transaction(1, [], outputs)
          return { txid: transaction.id('hex'), tx: transaction.toAtomicBEEF(true) }
        }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return { wallet, createdActions: () => actions }
}
