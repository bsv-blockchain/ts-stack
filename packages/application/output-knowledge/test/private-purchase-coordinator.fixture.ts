import { signOutputPacket, outputAssert, outputPacketDigest, type OutputJSONObject } from '@bsv/sdk'
import {
  PrivatePurchaseCoordinator,
  type PrivatePurchaseCoordinatorOptions
} from '../src/private/PrivatePurchaseCoordinator.js'
import type { PrivatePurchaseAdmissionOutcome } from '../src/private/PrivatePurchasePorts.js'
import { purchaseStoreFixture } from './private-purchase-store.fixture.js'

/** Actual native custody, controlled installed-premise ports and disclosed
 * lifecycle-only candidate bytes. This is not Bitcoin/admission proof.
 */
export function purchaseCoordinatorFixture(
  options: Partial<PrivatePurchaseCoordinatorOptions> = {}
) {
  const f = purchaseStoreFixture(),
    contract = f.f.f
  let authorized = true,
    domainCurrent = true,
    available = true,
    release = true,
    issue = true,
    admitted = true,
    validation = true,
    releaseCurrent = true
  const counts = { prepare: 0, verify: 0, admission: 0, issue: 0, terms: 0, potatoes: 0 }
  const caller = {
    buyer: f.buyer,
    capability: outputPacketDigest('capabilities', contract.body),
    profile: contract.body.services[0].profiles[0].id,
    current: () => authorized
  }
  const domain: PrivatePurchaseCoordinatorOptions['domain'] = {
    prepare: async () => {
      counts.prepare++
      outputAssert(available, 'Private material unavailable', 'unavailable')
      return {
        preparation: {
          terms: structuredClone(contract.terms),
          schema: f.custody.schema,
          maximumSecretBytes: 64,
          material: f.custody.material
        },
        validation: {
          checkCurrent: () => {
            outputAssert(validation, 'Listing context changed', 'context-changed')
          }
        }
      }
    },
    verify: async () => {
      counts.verify++
      outputAssert(validation, 'Purchase candidate invalid', 'invalid')
      return {
        checkCurrent: () => {
          outputAssert(validation, 'Purchase context changed', 'context-changed')
        }
      }
    },
    isCurrent: () => domainCurrent,
    issue: async () => {
      counts.issue++
      if (!issue) throw new Error('issuer unavailable')
      return f.custody.material
    }
  }
  const admission: PrivatePurchaseCoordinatorOptions['admission'] = {
    recover: async (job, _signal, context) => {
      context.checkCurrent()
      counts.admission++
      return admitted
        ? {
            status: 'admitted',
            operationId: job.operationId,
            txid: job.candidate.txid,
            steak: structuredClone(f.f.steak),
            acceptedAt: '20',
            assessmentContextId: 'original-admission'
          }
        : { status: 'unresolved', operationId: job.operationId, txid: job.candidate.txid }
    }
  }
  const owner: PrivatePurchaseCoordinatorOptions = {
    store: f.owner.store,
    contracts: contract.contracts,
    access: {
      guard: (_id, _buyer, current) => () => {
        outputAssert(current(), 'Buyer authority changed', 'not-found')
      }
    },
    domain,
    admission,
    release: {
      assess: async () =>
        release
          ? {
              evidence: {
                chain: contract.chain,
                txid: f.candidate.txid,
                policy: contract.installation.releasePolicy,
                acceptedAt: '20'
              },
              checkCurrent: () => {
                outputAssert(releaseCurrent, 'Release context changed', 'context-changed')
              }
            }
          : undefined
    },
    validationPolicy: f.policy,
    sign: async (type, body) => {
      counts[type === 'purchase-terms' ? 'terms' : 'potatoes']++
      return signOutputPacket(type, body, contract.key)
    },
    manifest: contract.manifest,
    clock: f.clock,
    ...options
  }
  let coordinator = new PrivatePurchaseCoordinator(owner),
    activeDomain = f.owner.domain
  const current = () => owner.store.load(f.id, f.buyer, f.clock, f.guard)
  const projected = () => {
    const loaded = current()!
    let result: unknown
    owner.store.disclose(loaded, f.buyer, f.clock, f.guard, envelope => {
      result = envelope
    })
    return result
  }
  return {
    f,
    owner,
    domain,
    admission,
    get coordinator() {
      return coordinator
    },
    caller,
    counts,
    current,
    projected,
    prepare: () => coordinator.prepare(contract.request, caller),
    submit: () => coordinator.submit(f.candidate, caller),
    recover: () => coordinator.recover(f.id, caller),
    reopen: async () => {
      await coordinator.stop()
      f.close(activeDomain)
      const reopened = f.open()
      activeDomain = reopened.domain
      owner.store = reopened.store
      coordinator = new PrivatePurchaseCoordinator(owner)
    },
    dispose: async () => {
      await coordinator.stop()
      f.dispose()
    },
    setAuthorized: (value: boolean) => {
      authorized = value
    },
    setDomainCurrent: (value: boolean) => {
      domainCurrent = value
    },
    setAvailable: (value: boolean) => {
      available = value
    },
    setRelease: (value: boolean) => {
      release = value
    },
    setIssue: (value: boolean) => {
      issue = value
    },
    setAdmitted: (value: boolean) => {
      admitted = value
    },
    setValidation: (value: boolean) => {
      validation = value
    },
    setReleaseCurrent: (value: boolean) => {
      releaseCurrent = value
    },
    sign: (type: 'purchase-terms' | 'potatoes', body: OutputJSONObject) =>
      signOutputPacket(type, body, contract.key),
    unresolved: (operationId: string): PrivatePurchaseAdmissionOutcome => ({
      status: 'unresolved',
      operationId,
      txid: f.candidate.txid
    })
  }
}
