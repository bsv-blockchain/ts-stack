import { outputAssert } from '@bsv/sdk'
import {
  PrivatePurchaseAliasCoordinator,
  type PrivatePurchaseAliasCoordinatorOptions
} from '../src/private/PrivatePurchaseAliasCoordinator.js'
import { PrivatePurchaseAccess } from '../src/private/PrivatePurchaseAccess.js'
import { identity } from './private-purchase-aliases.fixture.js'
import { purchaseAliasOwnerFixture } from './private-purchase-alias-owner.fixture.js'
import { purchaseCoordinatorFixture } from './private-purchase-coordinator.fixture.js'

/** Actual protected SQLite effect custody; controlled domain/admission/chain
 * premises. This demonstrates composition and restart, not BRC197 execution,
 * production chain selection, topical admission or portable License validity. */
export function purchaseAliasCoordinatorFixture(
  options: Partial<PrivatePurchaseAliasCoordinatorOptions> = {}
) {
  const f = purchaseAliasOwnerFixture(),
    base = purchaseCoordinatorFixture({}, f.base)
  let mined = false,
    current = true,
    failure = false
  const counts = { assessments: 0 }
  const installation: PrivatePurchaseAliasCoordinatorOptions = {
    ...base.owner,
    serviceDomain: f.base.owner.domain,
    store: f.store,
    aliases: f.f.owner,
    access: new PrivatePurchaseAccess(
      f.base.owner.domain,
      f.base.custody.original.request.topic,
      () => true,
      'full-purchase-commitment-v1',
      'alias-custody-v1'
    ),
    domain: {
      ...base.domain,
      async verify(candidate, custody, signal) {
        const validation = await base.domain.verify(candidate, custody, signal)
        return { ...validation, purchaseCommitment: identity }
      }
    },
    currentness: {
      async assess(_subject, candidate) {
        counts.assessments++
        if (!mined) return undefined
        await Promise.resolve()
        return {
          currentAlias: { txid: candidate.txid, beef: candidate.beef },
          contextId: 'controlled-alias-currentness',
          chainPolicyDigest: 'b2'.repeat(32),
          blockHash: 'b3'.repeat(32),
          height: '1',
          tipHash: 'b3'.repeat(32),
          tipHeight: '1',
          placement: {
            checkCurrent() {
              outputAssert(current, 'Controlled chain changed', 'context-changed')
            }
          }
        }
      }
    },
    failure: {
      async assess() {
        const assessment = failure
          ? {
              reason: 'Irrecoverable material',
              evidence: 'AA==',
              checkCurrent() {
                outputAssert(failure, 'Failure assessment changed', 'context-changed')
              }
            }
          : undefined
        await Promise.resolve()
        return assessment
      }
    },
    release: {
      async assess(custody, progress, candidate) {
        const assessment = {
          evidence: {
            chain: custody.original.request.listing.chain,
            txid: candidate.txid,
            policy: custody.original.terms.body.releasePolicy,
            acceptedAt: progress.admission!.acceptedAt
          },
          checkCurrent() {}
        }
        await Promise.resolve()
        return assessment
      }
    },
    ...options
  }
  let coordinator = new PrivatePurchaseAliasCoordinator(installation),
    active = f.base.owner.domain
  const prepare = () => coordinator.prepare(f.base.custody.original.request, base.caller)
  const recover = () => coordinator.recover(f.base.id, base.caller)
  const submit = (candidate = f.f.variant(40)) => coordinator.submit(candidate, base.caller)
  async function reopen() {
    await coordinator.stop()
    f.base.close(active)
    const opened = f.reopen()
    active = opened.domain
    installation.store = opened.owner
    installation.aliases = opened.aliases
    installation.serviceDomain = opened.domain
    installation.access = new PrivatePurchaseAccess(
      opened.domain,
      f.base.custody.original.request.topic,
      () => true,
      'full-purchase-commitment-v1',
      'alias-custody-v1'
    )
    coordinator = new PrivatePurchaseAliasCoordinator(installation)
  }
  async function dispose() {
    await coordinator.stop()
    await base.coordinator.stop()
    f.base.dispose()
  }
  return {
    f,
    base,
    installation,
    counts,
    get coordinator() {
      return coordinator
    },
    prepare,
    recover,
    submit,
    reopen,
    dispose,
    load() {
      return installation.store.load(f.base.id, f.base.buyer, f.f.clock, f.f.guard)!
    },
    setMined(value: boolean) {
      mined = value
    },
    setCurrent(value: boolean) {
      current = value
    },
    setFailure(value: boolean) {
      failure = value
    }
  }
}
