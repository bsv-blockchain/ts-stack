import { expect, it } from '@jest/globals'
import {
  Beef,
  OutputProtocolError,
  OutputPurchaseServiceError,
  OutputPurchaseTransport,
  Transaction,
  Utils,
  decodeOutputBytes,
  type OutputPurchaseEnvelope
} from '@bsv/sdk'
import { revenueListingPurchaseCommitment } from '@bsv/sdk/script/templates/RevenueListingSpend'
import {
  chains,
  context,
  minedChain,
  plainProvedEvidence,
  purchaseProof
} from '../../../../application/output-knowledge/test/revenue-lineage-fixture.js'
import type { ChainViewResolver } from '../../../../application/output-knowledge/src/index.js'
import { privatePurchaseNativeFixture } from './PrivatePurchaseNative.fixture.js'

// Compare the complete stored original transaction's identity after the existing
// independent domain/Script/License checks. A digest alone is not their oracle.
function expectRetainedCommitment(
  f: Awaited<ReturnType<typeof privatePurchaseNativeFixture>>,
  delivered: OutputPurchaseEnvelope
): void {
  if (delivered.result.status !== 'delivered') throw new Error('Fixture delivery missing')
  const retained = f.active.store.load(
    delivered.result.acquisitionId,
    f.asset.prepare.recipient,
    f.clock,
    () => {}
  )!
  expect(retained.state.format).toBe('private-purchase-state/2')
  const candidate = retained.candidate!,
    original = Transaction.fromBEEF(decodeOutputBytes(candidate.beef, 524288), candidate.txid),
    commitment = revenueListingPurchaseCommitment(original)
  expect(retained.progress.purchaseCommitment).toBe(commitment)
  expect(delivered.result.purchaseCommitment).toBe(commitment)
  expect(delivered.result.potatoes.body.purchaseCommitment).toBe(commitment)
}

async function retryClockConflict<T>(operation: () => Promise<T>, remaining = 8): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (
      (!(error instanceof OutputProtocolError) && !(error instanceof OutputPurchaseServiceError)) ||
      error.code !== 'conflict'
    )
      throw error
    if (remaining === 1)
      throw new Error('Original conflict reconciliation budget exhausted', { cause: error })
    // Retry only the original durable operation; no replacement request,
    // funding, candidate or relaxed clock/CAS guard is supplied.
    return retryClockConflict(operation, remaining - 1)
  }
}

it('constructs one real native purchase, authenticates submission, retains actual admission and decrypts licensed content', async () => {
  const f = await privatePurchaseNativeFixture()
  try {
    let owned = await f.openBuyer(true)
    await retryClockConflict(() => owned.buyer.advance())
    await owned.buyer.validate()
    const delivered = await owned.buyer.usableResult()
    expect(delivered.result.status).toBe('delivered')
    expectRetainedCommitment(f, delivered)
    expect(await f.playback(delivered)).toEqual(f.asset.plaintext)
    expect(f.native.counts.prepare).toBe(1)
    expect(f.native.counts.finalize).toBe(1)
    await f.reopenSeller()
    f.withdraw()
    await owned.close()
    await f.reopenLicense()
    await f.native.owner.close()
    const wallet = await f.native.reopen()
    owned = await f.openBuyer(false, wallet.payment)
    await owned.buyer.recover()
    const recovered = await owned.buyer.usableResult()
    expectRetainedCommitment(f, recovered)
    expect(recovered).toEqual(delivered)
    expect(await f.playback(recovered)).toEqual(f.asset.plaintext)
    f.setPermitted(false)
    await expect(owned.buyer.usableResult()).rejects.toMatchObject({ code: 'unauthorized' })
    f.setPermitted(true)
    await owned.close()
    expect(f.native.counts.prepare).toBe(1)
    expect(f.native.counts.finalize).toBe(1)
  } catch (error) {
    throw new AggregateError(
      [error, ...f.failures.slice(-1)],
      'Joint integration failed; retained host refusal is supplementary evidence'
    )
  } finally {
    await f.close()
  }
}, 120000)

it.each(['prepare', 'finalize', 'delivery'] as const)(
  'recovers a lost actual %s reply after reopening native buyer, wallet, seller and LCH custody',
  async lost => {
    const f = await privatePurchaseNativeFixture()
    try {
      const first = await f.openBuyer(true)
      if (lost === 'finalize') f.native.loseFinalization()
      else f.loseReply(lost)
      await expect(retryClockConflict(() => first.buyer.advance())).rejects.toThrow()
      if (lost !== 'finalize') expect(f.lostReplies).toHaveLength(1)
      else expect(f.native.counts.finalize).toBe(1)
      await first.close()
      await f.reopenSeller()
      await f.reopenLicense()
      await f.native.owner.close()
      const native = await f.native.reopen(),
        reopened = await f.openBuyer(false, native.payment),
        count = f.native.counts.finalize
      await retryClockConflict(() => reopened.buyer.recover())
      expect(f.native.counts.finalize).toBe(count)
      await retryClockConflict(() => reopened.buyer.advance())
      expect(await reopened.buyer.validate()).toBe('usable')
      const result = await reopened.buyer.usableResult()
      expectRetainedCommitment(f, result)
      expect(await f.playback(result)).toEqual(f.asset.plaintext)
      expect(f.native.counts.prepare).toBe(1)
      expect(f.native.counts.finalize).toBe(1)
      await reopened.close()
    } finally {
      await f.close()
    }
  },
  120000
)

it('coordinates two native buyers while a real delivered reply is physically pending without a second financial action', async () => {
  const f = await privatePurchaseNativeFixture()
  try {
    const first = await f.openBuyer(true),
      pause = f.pauseDelivery(),
      attempt = retryClockConflict(() => first.buyer.advance())
    // Attach rejection handling before waiting on the independent physical cut.
    const outcome = attempt.then(
      result => ({ result }),
      error => ({ error })
    )
    await Promise.race([
      pause.entered,
      outcome.then(result => {
        if ('error' in result) throw result.error
        throw new Error('Purchase ended before the physical delivery cut', { cause: result })
      })
    ])
    await expect(first.buyer.advance()).rejects.toThrow('still active')
    const second = await f.openBuyer(),
      recovered = await retryClockConflict(() => second.buyer.recover())
    expect(recovered?.result.status).toBe('delivered')
    // Recovery itself crosses the independent physical cut. Release before
    // additional Script/LCH work so those checks do not deliberately hold an
    // otherwise completed request beyond its unchanged 30-second deadline.
    pause.release()
    const finished = await outcome
    if ('error' in finished) {
      expect(finished.error).toBeInstanceOf(OutputProtocolError)
      expect(finished.error).toMatchObject({
        code: 'unavailable',
        message: 'Purchase buyer deadline'
      })
      expect(await retryClockConflict(() => first.buyer.recover())).toEqual(recovered)
    } else expect(finished.result).toEqual(recovered)
    expect(await second.buyer.validate()).toBe('usable')
    expect(await f.playback(await second.buyer.usableResult())).toEqual(f.asset.plaintext)
    expect(await first.buyer.usableResult()).toEqual(recovered)
    expect(f.native.counts.prepare).toBe(1)
    expect(f.native.counts.finalize).toBe(1)
    await first.close()
    await second.close()
  } finally {
    await f.close()
  }
}, 120000)

it('retains a genuinely richer checked same-raw proof after actual delivery without replacing admission or issuing another licence', async () => {
  let selected = { chains, context: context() }
  const selectedChains: ChainViewResolver = {
    resolve: (...args) => selected.chains.resolve(...args)
  }
  const f = await privatePurchaseNativeFixture({
    chains: selectedChains,
    view: () => selected.context
  })
  try {
    const buyer = await f.openBuyer(true)
    await retryClockConflict(() => buyer.buyer.advance())
    expect(await buyer.buyer.validate()).toBe('usable')
    const delivered = await buyer.buyer.usableResult(),
      original = f.active.store.load(
        f.native.terms.body.acquisitionId,
        f.asset.prepare.recipient,
        f.clock,
        () => {}
      )!
    expect(original.candidate).not.toBeNull()
    const firstCandidate = structuredClone(original.candidate!),
      cumulative = f.active.evidence.read(original.custody.original, f.clock, () => {}),
      rich = Beef.fromBinaryStrict(decodeOutputBytes(firstCandidate.beef, 524288)),
      tx = rich.findTransactionForSigning(firstCandidate.txid)!
    const raw = tx.toHex(),
      before = { ...f.counts },
      walletBefore = { ...f.native.counts }
    // This actually checked easy-work fork preserves the original genesis and
    // height-zero funding, and commits this exact raw purchase at mature height101.
    selected = minedChain(purchaseProof(firstCandidate.txid).computeRoot(), 101)
    const alternate = {
      ...firstCandidate,
      beef: Utils.toBase64(plainProvedEvidence(rich, firstCandidate.txid))
    }
    expect(alternate.beef).not.toBe(firstCandidate.beef)
    expect(
      Transaction.fromBEEF(decodeOutputBytes(alternate.beef, 524288), firstCandidate.txid).toHex()
    ).toBe(raw)
    const transport = () =>
      new OutputPurchaseTransport({
        contract: f.retained,
        trust: f.trust,
        request: f.asset.prepare,
        wallet: f.wallet,
        fetch: f.wire,
        operation: 'submit',
        terms: original.custody.original.terms,
        candidate: alternate
      })
    const result = await retryClockConflict(() => transport().send())
    expect(result).toEqual(delivered)
    const retained = f.active.evidence.read(original.custody.original, f.clock, () => {})
    expect(retained.candidate).not.toBeNull()
    expect(retained.candidate!.beef).not.toBe(cumulative.candidate!.beef)
    const retainedBeef = Beef.fromBinaryStrict(decodeOutputBytes(retained.candidate!.beef, 524288)),
      retainedTx = retainedBeef.findAtomicTransaction(firstCandidate.txid)!
    expect(retainedTx.toHex()).toBe(raw)
    expect(retainedTx.merklePath?.blockHeight).toBe(101)
    expect(retainedBeef.txs.map(item => item.txid).sort()).toEqual(
      rich.txs.map(item => item.txid).sort()
    )
    const stored = f.active.store.load(
      firstCandidate.acquisitionId,
      f.asset.prepare.recipient,
      f.clock,
      () => {}
    )!
    expect(stored.candidate).toEqual(firstCandidate)
    expect(stored.progress).toEqual(original.progress)
    expect(stored.state.result).toEqual(original.state.result)
    expect(result.releaseEvidence?.policy.kind).toBe('local-admission')
    expect(f.counts).toEqual(before)
    expect(f.native.counts).toEqual(walletBefore)
    await f.reopenSeller()
    const reopened = f.active.evidence.read(original.custody.original, f.clock, () => {})
    expect(reopened.candidate).toEqual(retained.candidate)
    expect(await retryClockConflict(() => transport().send())).toEqual(delivered)
    expect(f.counts).toEqual(before)
    expect(f.native.counts).toEqual(walletBefore)
    expect(await f.playback(delivered)).toEqual(f.asset.plaintext)
    await buyer.close()
  } catch (error) {
    throw new AggregateError(
      [error, ...f.failures.slice(-1)],
      'Richer proof integration failed; original host refusal is supplementary evidence'
    )
  } finally {
    await f.close()
  }
}, 120000)
