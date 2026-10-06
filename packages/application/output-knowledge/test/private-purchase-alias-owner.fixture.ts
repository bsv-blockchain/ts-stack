import {
  outputPacketDigest,
  type OutputPurchaseEnvelope,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import { SQLitePrivatePurchaseAliasStore } from '../src/private/SQLitePrivatePurchaseAliasStore.js'
import type { PrivatePurchaseAliasedLoaded } from '../src/private/PrivatePurchaseAliasOwnerPorts.js'
import { SQLitePrivatePurchaseAliases } from '../src/private/SQLitePrivatePurchaseAliases.js'
import { privatePurchaseOperation } from '../src/private/PrivatePurchaseProgress.js'
import {
  purchaseAliasesFixture,
  identity,
  placement,
  retained,
  verified
} from './private-purchase-aliases.fixture.js'
import { signPurchaseFixturePacket } from './private-purchase-signing.fixture.js'

/** Actual encrypted SQLite composition with disclosed OP_TRUE transactions and
 * controlled identity/admission/placement premises. This proves effect custody,
 * not BRC197 execution, mining, topical admission or private licence issuance. */
export function purchaseAliasOwnerFixture(maximumSelections = 8, maximumBatchBytes = 2 * 1048576) {
  const f = purchaseAliasesFixture(),
    base = f.e.base,
    limits = { ...base.limits, maximumBatchBytes },
    store = new SQLitePrivatePurchaseAliasStore(
      base.owner.domain,
      base.f.f.contracts,
      f.owner,
      limits,
      base.policy,
      maximumSelections
    )
  const prepare = () => store.prepare(base.custody, f.clock, f.guard)
  const load = (use = store) => {
    const saved = use.load(base.id, base.buyer, f.clock, f.guard)
    if (!saved) throw new Error('Expected original owner custody')
    return saved
  }
  function retain(
    candidate: OutputPurchaseSubmit,
    selected = false,
    use = store,
    aliases = f.owner
  ) {
    const saved = load(use)
    const write = retained(
      aliases.propose(
        base.custody.original,
        candidate,
        verified(),
        selected ? placement() : undefined,
        f.clock,
        f.guard
      )
    )
    return use.retain(saved, write, f.clock, f.guard, verified())
  }
  function admitted(candidate: OutputPurchaseSubmit, aliases = f.owner) {
    retained(
      aliases.admission(base.custody.original, candidate.txid, undefined, f.clock, f.guard)
    ).retain(f.clock, f.guard)
    retained(
      aliases.admission(
        base.custody.original,
        candidate.txid,
        {
          status: 'admitted',
          operationId: privatePurchaseOperation(base.custody.original, candidate.txid),
          txid: candidate.txid,
          steak: base.f.steak,
          acceptedAt: f.clock(),
          assessmentContextId: 'controlled-owner-admission'
        },
        f.clock,
        f.guard
      )
    ).retain(f.clock, f.guard)
  }
  function envelope(saved: PrivatePurchaseAliasedLoaded): OutputPurchaseEnvelope {
    const prior = base.f.envelope()
    if (prior.result.status !== 'delivered' || !saved.progress.txid)
      throw new Error('Fixture must have selected admission')
    const evidence = {
      chain: base.f.f.chain,
      txid: saved.progress.txid,
      policy: base.custody.original.terms.body.releasePolicy,
      acceptedAt: saved.progress.admission!.acceptedAt
    }
    const potatoes = signPurchaseFixturePacket(
      'potatoes',
      {
        ...prior.result.potatoes.body,
        txid: saved.progress.txid,
        purchaseCommitment: identity,
        evidenceDigest: outputPacketDigest('release-evidence', evidence),
        issuedAt: f.clock()
      },
      base.f.f.key
    )
    return {
      result: {
        ...prior.result,
        txid: saved.progress.txid,
        purchaseCommitment: identity,
        steak: saved.progress.admission!.steak,
        potatoes
      },
      releaseEvidence: evidence
    }
  }
  function reopen() {
    const opened = base.open(),
      aliases = new SQLitePrivatePurchaseAliases(opened.domain, base.f.f.contracts, f.limits)
    const owner = new SQLitePrivatePurchaseAliasStore(
      opened.domain,
      base.f.f.contracts,
      aliases,
      limits,
      base.policy,
      maximumSelections
    )
    return { owner, aliases, domain: opened.domain }
  }
  return { f, base, limits, store, prepare, load, retain, admitted, envelope, reopen }
}
