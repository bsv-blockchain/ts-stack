import { Beef, Transaction, UnlockingScript, Utils, type OutputPurchaseSubmit } from '@bsv/sdk'
import {
  SQLitePrivatePurchaseAliases,
  type PrivatePurchaseAliasWrite
} from '../src/private/SQLitePrivatePurchaseAliases.js'
import { privatePurchaseOperation } from '../src/private/PrivatePurchaseProgress.js'
import { purchaseEvidenceFixture } from './private-purchase-evidence.fixture.js'

// Real encrypted native persistence, with disclosed toy OP_TRUE/identity/placement
// guards. This fixture does not qualify BRC197 Script, chain inclusion or issuance.
export const identity = 'b1'.repeat(32)
export const verified = () => ({ purchaseCommitment: identity, checkCurrent: () => undefined })
export const placement = () => ({ checkCurrent: () => undefined })
export function retained(plan: PrivatePurchaseAliasWrite) {
  if (plan.status !== 'ready') throw Error('Expected retained native proposal')
  return plan
}
export function purchaseAliasesFixture(maximumWrites = 64) {
  const e = purchaseEvidenceFixture(),
    limits = {
      maximumCandidateBytes: 8192,
      maximumUnconfirmed: 1,
      maximumPending: 2,
      maximumWrites,
      maximumBatchBytes: 2 * 1048576
    }
  const construct = (domain = e.base.owner.domain) =>
    new SQLitePrivatePurchaseAliases(domain, e.base.f.f.contracts, limits)
  const owner = construct(),
    { clock, guard } = e.base
  function variant(n: number): OutputPurchaseSubmit {
    const target = Transaction.fromHex(e.target.toHex())
    // The disclosed toy input is OP_TRUE. A push/drop changes only its raw
    // unlocking bytes and leaves the same input/output transaction semantics.
    target.inputs[0].unlockingScript = UnlockingScript.fromHex(
      `01${n.toString(16).padStart(2, '0')}75`
    )
    const beef = new Beef()
    beef.mergeTransaction(target)
    return {
      ...e.candidate,
      txid: target.id('hex'),
      beef: Utils.toBase64(beef.toBinaryAtomic(target.id('hex')))
    }
  }
  function put(candidate: OutputPurchaseSubmit, selected = false, use = owner) {
    const plan = retained(
      use.propose(
        e.original,
        candidate,
        verified(),
        selected ? placement() : undefined,
        clock,
        guard
      )
    )
    plan.retain(clock, guard, verified())
    return plan
  }
  function pending(candidate: OutputPurchaseSubmit, use = owner) {
    retained(use.admission(e.original, candidate.txid, undefined, clock, guard)).retain(
      clock,
      guard
    )
  }
  function admit(candidate: OutputPurchaseSubmit, use = owner) {
    pending(candidate, use)
    const outcome = {
      status: 'admitted' as const,
      operationId: privatePurchaseOperation(e.original, candidate.txid),
      txid: candidate.txid,
      steak: e.base.f.steak,
      acceptedAt: '20',
      assessmentContextId: 'storage-unit-view'
    }
    retained(use.admission(e.original, candidate.txid, outcome, clock, guard)).retain(clock, guard)
  }
  const read = (use = owner) => use.read(e.original, clock, guard)
  const reopen = () => construct(e.base.open().domain)
  return { e, limits, construct, owner, clock, guard, variant, put, pending, admit, read, reopen }
}
