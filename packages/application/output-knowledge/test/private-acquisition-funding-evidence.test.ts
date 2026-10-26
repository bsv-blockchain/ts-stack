import { describe, expect, it } from '@jest/globals'
import {
  Beef,
  LockingScript,
  OutputProtocolError,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  Utils
} from '@bsv/sdk'
import { SDKPrivateAcquisitionFunding } from '../src/private/SDKPrivateAcquisitionFunding.js'
import { chain, context, resolver, transactions } from './evidence-fixture.js'
import { acquisitionFixture } from './private-acquisition.fixture.js'

async function fixture() {
  const f = await acquisitionFixture(),
    wallet = new ProtoWallet(new PrivateKey(83))
  const transaction = new Transaction(
    1,
    [
      {
        sourceTransaction: transactions.get('P')!,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(63)),
        sequence: 0xffffffff
      }
    ],
    [
      {
        satoshis: 100,
        lockingScript: new P2PKH().lock(PublicKey.fromString(f.sellerPaymentKey).toAddress())
      }
    ],
    0
  )
  await transaction.sign()
  const payment = { ...f.payment(), transaction: Utils.toBase64(transaction.toAtomicBEEF()) }
  return { ...f, wallet, transaction, payment }
}
describe('native BRC-29 acquisition funding verification', () => {
  it('independently verifies the seller output using only the buyer wallet', async () => {
    const f = await fixture(),
      buyer = new ProtoWallet(new PrivateKey(84)),
      verifier = new SDKPrivateAcquisitionFunding(resolver, buyer, () => context())
    const result = await verifier.verifyForBuyer(f.payment, f.challenge, chain)
    expect(result.sellerPaymentKey).toBe(f.sellerPaymentKey)
    expect(result.operation.funding).toEqual({
      chain,
      txid: f.transaction.id('hex'),
      outputIndex: 0
    })
    await expect(
      new SDKPrivateAcquisitionFunding(resolver, f.wallet, () => context()).verifyForBuyer(
        f.payment,
        f.challenge,
        chain
      )
    ).rejects.toMatchObject({ code: 'context-changed' })
    const changed = new Transaction(
      f.transaction.version,
      f.transaction.inputs,
      [...f.transaction.outputs, { satoshis: 1, lockingScript: LockingScript.fromHex('51') }],
      f.transaction.lockTime
    )
    await expect(
      verifier.verifyForBuyer(
        { ...f.payment, transaction: Utils.toBase64(changed.toAtomicBEEF()) },
        f.challenge,
        chain
      )
    ).rejects.toMatchObject({ code: 'invalid' })
  })
  it('derives the seller output and verifies its signed transaction and ancestry', async () => {
    const f = await fixture(),
      selected = context()
    const verifier = new SDKPrivateAcquisitionFunding(
      resolver,
      f.wallet,
      (operation, challenge) => {
        expect(operation.funding.outputIndex).toBe(0)
        expect(challenge).toEqual(f.challenge)
        operation.seller = f.buyer
        return selected
      }
    )
    const result = await verifier.verify(f.payment, f.challenge, chain)
    expect(result).toMatchObject({
      sellerPaymentKey: f.sellerPaymentKey,
      rawTransaction: Utils.toBase64(f.transaction.toBinary()),
      operation: {
        seller: f.seller,
        buyer: f.buyer,
        satoshis: '100',
        funding: { chain, txid: f.transaction.id('hex'), outputIndex: 0 }
      },
      verificationContext: selected
    })
    result.verificationContext.view.id = 'changed'
    expect(selected.view.id).toBe('base')
  })
  it('rejects a payment with a broken input signature even when its output is exactly correct', async () => {
    const f = await fixture()
    const changed = new Transaction(
      f.transaction.version,
      f.transaction.inputs,
      [...f.transaction.outputs, { satoshis: 1, lockingScript: LockingScript.fromHex('51') }],
      f.transaction.lockTime
    )
    await expect(
      new SDKPrivateAcquisitionFunding(resolver, f.wallet, () => context()).verify(
        { ...f.payment, transaction: Utils.toBase64(changed.toAtomicBEEF()) },
        f.challenge,
        chain
      )
    ).rejects.toMatchObject({ code: 'invalid', retryable: false })
  })
  it('rejects duplicate exact scripts, underpayment, overpayment and a missing matching script', async () => {
    const f = await fixture()
    for (const outputs of [
      [...f.transaction.outputs, { ...f.transaction.outputs[0], satoshis: 1 }],
      [{ ...f.transaction.outputs[0], satoshis: 99 }],
      [{ ...f.transaction.outputs[0], satoshis: 101 }],
      [{ ...f.transaction.outputs[0], lockingScript: LockingScript.fromHex('51') }]
    ]) {
      const changed = new Transaction(
        f.transaction.version,
        f.transaction.inputs,
        outputs,
        f.transaction.lockTime
      )
      await expect(
        new SDKPrivateAcquisitionFunding(resolver, f.wallet, () => context()).verify(
          { ...f.payment, transaction: Utils.toBase64(changed.toAtomicBEEF()) },
          f.challenge,
          chain
        )
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })
  it('refuses a non-Atomic bundle and keeps unavailable ancestry retryable', async () => {
    const f = await fixture(),
      verifier = new SDKPrivateAcquisitionFunding(resolver, f.wallet, () => context())
    await expect(
      verifier.verify(
        { ...f.payment, transaction: Utils.toBase64(f.transaction.toBEEF()) },
        f.challenge,
        chain
      )
    ).rejects.toMatchObject({ code: 'invalid' })
    const incomplete = new Beef()
    incomplete.mergeTransaction(Transaction.fromBinary(f.transaction.toBinary()))
    // Remove the anchored dependency while preserving the actual target bytes.
    const parent =
      f.transaction.inputs[0].sourceTXID ?? f.transaction.inputs[0].sourceTransaction!.id('hex')
    incomplete.mergeTxidOnly(parent)
    await expect(
      verifier.verify(
        {
          ...f.payment,
          transaction: Utils.toBase64(incomplete.toBinaryAtomic(f.transaction.id('hex')))
        },
        f.challenge,
        chain
      )
    ).rejects.toMatchObject({ code: 'unavailable', retryable: true })
  })
  it('rejects changed chain context and wallet identity before resolving ancestry', async () => {
    const f = await fixture()
    let calls = 0
    const chains = {
      resolve: async (...args: Parameters<typeof resolver.resolve>) => {
        calls++
        return resolver.resolve(...args)
      }
    }
    await expect(
      new SDKPrivateAcquisitionFunding(chains, f.wallet, () => ({
        ...context(),
        view: { ...context().view, chain: { ...chain, network: 'wrong' } }
      })).verify(f.payment, f.challenge, chain)
    ).rejects.toMatchObject({ code: 'context-changed' })
    await expect(
      new SDKPrivateAcquisitionFunding(chains, new ProtoWallet(new PrivateKey(84)), () =>
        context()
      ).verify(f.payment, f.challenge, chain)
    ).rejects.toMatchObject({ code: 'context-changed' })
    expect(calls).toBe(0)
  })
  it('owns input bytes before callbacks and never exposes private wallet exception text', async () => {
    const f = await fixture(),
      original = { ...f.payment }
    const wallet = {
      getPublicKey: async (...args: Parameters<typeof f.wallet.getPublicKey>) => {
        original.transaction = ''
        return await f.wallet.getPublicKey(...args)
      }
    }
    expect(
      (
        await new SDKPrivateAcquisitionFunding(resolver, wallet, () => context()).verify(
          original,
          f.challenge,
          chain
        )
      ).operation.beef
    ).toBe(f.payment.transaction)
    await expect(
      new SDKPrivateAcquisitionFunding(
        resolver,
        {
          getPublicKey: async () => {
            throw new OutputProtocolError('context-changed', 'SYNTHETIC-PRIVATE-TEXT')
          }
        },
        () => context()
      ).verify(f.payment, f.challenge, chain)
    ).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
      message: 'Acquisition funding derivation is unavailable'
    })
  })
  it('stops cancelled verification and refuses the wrong prefix before wallet calls', async () => {
    const f = await fixture(),
      abort = new AbortController()
    let calls = 0
    const wallet = {
      getPublicKey: async (...args: Parameters<typeof f.wallet.getPublicKey>) => {
        calls++
        abort.abort()
        return await f.wallet.getPublicKey(...args)
      }
    }
    await expect(
      new SDKPrivateAcquisitionFunding(resolver, wallet, () => context()).verify(
        f.payment,
        f.challenge,
        chain,
        abort.signal
      )
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(calls).toBe(1)
    await expect(
      new SDKPrivateAcquisitionFunding(resolver, wallet, () => context()).verify(
        f.payment,
        f.challenge,
        chain,
        abort.signal
      )
    ).rejects.toMatchObject({ code: 'cancelled' })
    await expect(
      new SDKPrivateAcquisitionFunding(resolver, wallet, () => context()).verify(
        { ...f.payment, derivationPrefix: 'other' },
        f.challenge,
        chain
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(calls).toBe(1)
  })
})
