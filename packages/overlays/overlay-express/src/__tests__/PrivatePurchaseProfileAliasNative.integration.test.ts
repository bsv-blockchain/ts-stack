import { expect, it } from '@jest/globals'
import {
  canonicalOutputJSON,
  decodeOutputBytes,
  OutputProtocolError,
  OutputPurchaseServiceError,
  OutputPurchaseTransport,
  Transaction,
  type OutputPurchaseEnvelope,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import { revenueListingPurchaseCommitment } from '@bsv/sdk/script/templates/RevenueListingSpend'
import { privatePurchaseProfileAliasNativeFixture } from './PrivatePurchaseProfileAliasNative.fixture.js'

type Fixture = Awaited<ReturnType<typeof privatePurchaseProfileAliasNativeFixture>>

// A bounded retry of the same durable operation reconciles a wall-clock/CAS
// conflict. It cannot construct another candidate, fund, or relax any guard.
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
    return retryClockConflict(operation, remaining - 1)
  }
}

function loadOriginal(f: Fixture) {
  const original = f.active.store.load(
    f.native.terms.body.acquisitionId,
    f.asset.prepare.recipient,
    f.clock,
    () => {}
  )!
  expect(original.state.format).toBe('private-purchase-state/3')
  expect(original.candidate).not.toBeNull()
  return original
}

function historical(envelope: OutputPurchaseEnvelope): string {
  const { currentAlias: _optionalPlacement, ...original } = envelope
  return canonicalOutputJSON(original)
}

function expectRetainedCommitment(f: Fixture, envelope: OutputPurchaseEnvelope): void {
  if (envelope.result.status !== 'delivered') throw new Error('Current-profile delivery missing')
  const original = loadOriginal(f),
    candidate = original.candidate!,
    transaction = Transaction.fromBEEF(decodeOutputBytes(candidate.beef, 524288), candidate.txid),
    commitment = revenueListingPurchaseCommitment(transaction)
  expect(original.progress.purchaseCommitment).toBe(commitment)
  expect(envelope.result.purchaseCommitment).toBe(commitment)
  expect(envelope.result.potatoes.body.purchaseCommitment).toBe(commitment)
}

async function submitAlias(
  f: Fixture,
  candidate: OutputPurchaseSubmit
): Promise<OutputPurchaseEnvelope> {
  const original = loadOriginal(f),
    terms = original.custody.original.terms,
    domain = f.buyerDomain,
    signal = new AbortController().signal
  expect(domain.candidateBinding).toBeDefined()
  // This companion requires independent full domain verification of both raw
  // transactions. A seller-reported commitment alone cannot select it.
  const funded = await domain.candidateBinding!(
      f.asset.prepare,
      terms,
      original.candidate!,
      signal
    ),
    alias = await domain.candidateBinding!(f.asset.prepare, terms, candidate, signal)
  expect(alias.purchaseCommitment).toBe(funded.purchaseCommitment)
  return retryClockConflict(async () => {
    funded.checkCurrent()
    alias.checkCurrent()
    const response = await new OutputPurchaseTransport({
      contract: f.retained,
      trust: f.trust,
      request: f.asset.prepare,
      wallet: f.wallet,
      fetch: f.wire,
      operation: 'submit',
      terms,
      candidate,
      commitmentBinding: {
        profile: 'full-purchase-commitment-v1',
        domainProfile: terms.body.domainProfile,
        purchaseCommitment: funded.purchaseCommitment
      }
    }).send()
    funded.checkCurrent()
    alias.checkCurrent()
    return response
  })
}

it('composes the current immutable reserve/activation/purchase Script with native funding, actual topical admission, authenticated custody and licensed playback across reopen', async () => {
  const f = await privatePurchaseProfileAliasNativeFixture()
  try {
    let owner = await f.openBuyer(true)
    await retryClockConflict(() => owner.buyer.advance())
    expect(await owner.buyer.validate()).toBe('usable')
    const delivered = await owner.buyer.usableResult(),
      counts = { ...f.counts }
    expectRetainedCommitment(f, delivered)
    expect(delivered.releaseEvidence?.policy.kind).toBe('local-admission')
    expect(await f.playback(delivered)).toEqual(f.asset.plaintext)
    expect(f.native.counts.prepare).toBe(1)
    expect(f.native.counts.finalize).toBe(1)
    expect(f.counts.issuance).toBe(1)
    await owner.close()
    await f.reopenSeller()
    await f.reopenLicense()
    await f.native.owner.close()
    const wallet = await f.native.reopen()
    f.withdraw()
    owner = await f.openBuyer(false, wallet.payment)
    await retryClockConflict(() => owner.buyer.recover())
    const recovered = await owner.buyer.usableResult()
    expect(historical(recovered)).toBe(historical(delivered))
    expectRetainedCommitment(f, recovered)
    expect(await f.playback(recovered)).toEqual(f.asset.plaintext)
    expect(f.counts).toEqual(counts)
    expect(f.native.counts.prepare).toBe(1)
    expect(f.native.counts.finalize).toBe(1)
    f.setPermitted(false)
    await expect(owner.buyer.usableResult()).rejects.toMatchObject({ code: 'unauthorized' })
    f.setPermitted(true)
    await owner.close()
  } finally {
    await f.close()
  }
}, 120000)

it('requires independently checked mined placement and actual admission of an equivalent alias before the first mined-policy secret, then retains that historical grant', async () => {
  const f = await privatePurchaseProfileAliasNativeFixture(undefined, {
    kind: 'mined',
    confirmations: 1
  })
  try {
    const owner = await f.openBuyer(true)
    const pending = await retryClockConflict(() => owner.buyer.advance())
    expect(pending.result.status).toBe('admitted-delivery-pending')
    expect('potatoes' in pending.result).toBe(false)
    expect(pending.releaseEvidence).toBeUndefined()
    expect(f.counts.issuance).toBe(0)
    const original = loadOriginal(f),
      paid = original.candidate!,
      paidTransaction = Transaction.fromBEEF(decodeOutputBytes(paid.beef, 524288), paid.txid),
      commitment = revenueListingPurchaseCommitment(paidTransaction),
      walletCounts = { ...f.native.counts },
      alternative = await f.native.alternativeCandidate(paid)
    expect(alternative.txid).not.toBe(paid.txid)
    const proved = await f.proveCandidate(alternative),
      delivered = await submitAlias(f, proved)
    expect(delivered.result.status).toBe('delivered')
    if (delivered.result.status !== 'delivered')
      throw Error('Mined alias failed to satisfy the original release policy')
    expect(delivered.result.txid).toBe(proved.txid)
    expect(delivered.result.purchaseCommitment).toBe(commitment)
    expect(delivered.result.potatoes.body.txid).toBe(proved.txid)
    expect(delivered.result.potatoes.body.purchaseCommitment).toBe(commitment)
    expect(delivered.releaseEvidence).toMatchObject({
      txid: proved.txid,
      policy: { kind: 'mined', confirmations: 1 },
      blockEvidence: { height: '102', tipHeight: '102' }
    })
    expect(f.counts.issuance).toBe(1)
    expect(f.native.counts).toEqual(walletCounts)
    await retryClockConflict(() => owner.buyer.recover())
    // Before its first retained delivery, read-only recovery reconciles the
    // original finalized wallet once. It never prepares or finalizes again.
    const deliveredWalletCounts = { ...walletCounts, recover: walletCounts.recover + 1 }
    expect(f.native.counts).toEqual(deliveredWalletCounts)
    expect(await owner.buyer.validate()).toBe('usable')
    const retained = await owner.buyer.usableResult(),
      saved = await owner.state.read()
    expect(historical(retained)).toBe(historical(delivered))
    expect(await f.playback(retained)).toEqual(f.asset.plaintext)
    await f.reopenSeller()
    await f.regressProof()
    expect(await owner.buyer.currentAlias(owner.aliasCurrentness)).toBeUndefined()
    expect(await owner.state.read()).toEqual(saved)
    expect(historical(await owner.buyer.usableResult())).toBe(historical(retained))
    expect(await f.playback(retained)).toEqual(f.asset.plaintext)
    expect(f.counts.issuance).toBe(1)
    expect(f.native.counts).toEqual(deliveredWalletCounts)
    await owner.close()
  } finally {
    await f.close()
  }
}, 120000)

it('admits a distinct valid raw transaction with the same full purchase commitment and independently reports its selected placement without changing the original private grant', async () => {
  const f = await privatePurchaseProfileAliasNativeFixture()
  try {
    const owner = await f.openBuyer(true)
    await retryClockConflict(() => owner.buyer.advance())
    expect(await owner.buyer.validate()).toBe('usable')
    const delivered = await owner.buyer.usableResult(),
      original = loadOriginal(f),
      saved = await owner.state.read(),
      walletCounts = { ...f.native.counts },
      originalBytes = canonicalOutputJSON({
        candidate: original.candidate,
        progress: original.progress,
        result: original.state.result
      }),
      alternative = await f.native.alternativeCandidate(original.candidate!)
    expect(alternative.txid).not.toBe(original.candidate!.txid)
    const originalTransaction = Transaction.fromBEEF(
        decodeOutputBytes(original.candidate!.beef, 524288),
        original.candidate!.txid
      ),
      alternativeTransaction = Transaction.fromBEEF(
        decodeOutputBytes(alternative.beef, 524288),
        alternative.txid
      )
    expect(alternativeTransaction.toHex()).not.toBe(originalTransaction.toHex())
    expect(revenueListingPurchaseCommitment(alternativeTransaction)).toBe(
      revenueListingPurchaseCommitment(originalTransaction)
    )
    const proved = await f.proveCandidate(alternative),
      response = await submitAlias(f, proved)
    expect(historical(response)).toBe(historical(delivered))
    expect(response.currentAlias?.txid).toBe(proved.txid)
    const selected = loadOriginal(f)
    expect(selected.aliases.state.selected?.txid).toBe(proved.txid)
    expect(selected.aliases.state.selected?.admission).toBe('admitted')
    expect(
      canonicalOutputJSON({
        candidate: selected.candidate,
        progress: selected.progress,
        result: selected.state.result
      })
    ).toBe(originalBytes)
    const requests = f.requests.length,
      counts = { ...f.counts },
      report = (await owner.buyer.currentAlias(owner.aliasCurrentness))!
    expect(report.currentAlias.txid).toBe(proved.txid)
    expect(report.height).toBe('102')
    expect(report.tipHeight).toBe('102')
    expect(() => report.placement.checkCurrent()).not.toThrow()
    expect(f.requests.slice(requests)).toHaveLength(1)
    expect(f.requests.at(-1)).toContain('/recover')
    expect(await owner.state.read()).toEqual(saved)
    expect(historical(await owner.buyer.usableResult())).toBe(historical(delivered))
    expect(f.counts).toEqual(counts)
    expect(f.native.counts).toEqual(walletCounts)
    await f.regressProof()
    expect(() => report.placement.checkCurrent()).toThrow()
    expect(await owner.buyer.currentAlias(owner.aliasCurrentness)).toBeUndefined()
    expect(historical(await owner.buyer.usableResult())).toBe(historical(delivered))
    expect(await f.playback(delivered)).toEqual(f.asset.plaintext)
    expect(f.counts.issuance).toBe(1)
    expect(f.native.counts).toEqual(walletCounts)
    await owner.close()
  } finally {
    await f.close()
  }
}, 120000)

it('refuses the seller-reported mined alias above the independently selected buyer tip while retaining historical License, POTATOES and settlement', async () => {
  const f = await privatePurchaseProfileAliasNativeFixture()
  try {
    const owner = await f.openBuyer(true)
    await retryClockConflict(() => owner.buyer.advance())
    expect(await owner.buyer.validate()).toBe('usable')
    const delivered = await owner.buyer.usableResult(),
      saved = await owner.state.read(),
      original = loadOriginal(f),
      walletCounts = { ...f.native.counts },
      proved = await f.proveCandidate(await f.native.alternativeCandidate(original.candidate!))
    const seller = await submitAlias(f, proved)
    expect(seller.currentAlias?.txid).toBe(proved.txid)
    f.selectBuyerHeight(101)
    await expect(owner.buyer.currentAlias(owner.aliasCurrentness)).rejects.toThrow()
    expect(await owner.state.read()).toEqual(saved)
    expect(historical(await owner.buyer.usableResult())).toBe(historical(delivered))
    expect(await f.playback(delivered)).toEqual(f.asset.plaintext)
    expect(f.counts.issuance).toBe(1)
    expect(f.native.counts).toEqual(walletCounts)
    f.selectBuyerHeight()
    expect((await owner.buyer.currentAlias(owner.aliasCurrentness))!.currentAlias.txid).toBe(
      proved.txid
    )
    await owner.close()
  } finally {
    await f.close()
  }
}, 120000)
