import { fixturePromise } from './private-async.fixture.js'
import type { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { expect, jest } from '@jest/globals'
import {
  PrivatePublicationCoordinator,
  type PrivatePublicationCoordinatorOptions
} from '../src/private/PrivatePublicationCoordinator.js'
import { PrivatePublicationAccess } from '../src/private/PrivatePublicationAccess.js'
import { PrivatePublicationVerificationLeases } from '../src/private/PrivatePublicationVerificationLeases.js'
import { SDKPrivatePublicationEvidence } from '../src/private/SDKPrivatePublicationEvidence.js'
import { verifiedFixture } from './private-verified-publication-fixture.js'
import { resolver, context } from './evidence-fixture.js'
import { allow } from './private-publication-fixture.js'
import type { PrivatePublicationAdmission } from '../src/private/PrivatePublicationPorts.js'

export function coordinatorFixture(
  overrides: Partial<PrivatePublicationCoordinatorOptions> = {},
  payloads?: NodeProtectedPayloadCodec
) {
  const f = verifiedFixture(payloads)
  let now = '20',
    active = true,
    chainActive = true,
    permitted = true
  const evidence = new SDKPrivatePublicationEvidence(resolver, () => context())
  const leases = new PrivatePublicationVerificationLeases(() => chainActive)
  const calls: string[] = []
  const access = new PrivatePublicationAccess(
    f.native.owner,
    f.contract.installation.topic,
    () => permitted
  )
  const admission: PrivatePublicationAdmission = {
    maximumPrivateBytes: 100000,
    maximumOutcomeBytes: 4096,
    recover(job, _selection, reference) {
      return fixturePromise(() => {
        expect(leases.isCurrent(reference)).toBe(true)
        const stored = f.store.loadVerified(job.publicationId, () => now, allow)!
        expect(stored.fence.state.progress.phase).toBe('admitting')
        expect(stored.blob.privateValues).toBe(job.request.privateValues)
        calls.push(job.operationId)
        return {
          status: 'admitted',
          operationId: job.operationId,
          txid: job.request.evidence.txid,
          steak: {
            [job.request.topic]: {
              outputsToAdmit: [job.request.evidence.outputIndex],
              coinsToRetain: [],
              coinsRemoved: []
            }
          },
          assessmentContextId: 'original-assessment',
          context: 'matching-private-values'
        }
      })
    }
  }
  const validate: jest.Mock<PrivatePublicationCoordinatorOptions['validate']> = jest.fn<
    PrivatePublicationCoordinatorOptions['validate']
  >((request, verified) =>
    fixturePromise(() => {
      expect(request.privateValues).toBe('AQID')
      expect(verified.rawTransaction).toBe(f.contract.record.rawTransaction)
    })
  )
  const manifest: jest.Mock<PrivatePublicationCoordinatorOptions['manifest']> = jest.fn<
    PrivatePublicationCoordinatorOptions['manifest']
  >(() => f.contract.retained.selection.manifest)
  const options: PrivatePublicationCoordinatorOptions = {
    store: f.store,
    contracts: f.contract.contracts,
    evidence,
    access,
    leases,
    admission,
    validate,
    validationPolicy: f.contract.policy,
    lookup: f.service.lookup,
    manifest,
    clock: () => now,
    stagingSeconds: '10',
    ...overrides
  }
  const coordinator = new PrivatePublicationCoordinator(options)
  const caller = {
    publisher: f.selected.publisher,
    capability: f.contract.retained.selection.digest,
    profile: f.contract.retained.selection.profile.id,
    current: () => active
  }
  const status = { version: 1 as const, publicationId: f.contract.record.publicationId }
  return {
    ...f,
    coordinator,
    caller,
    status,
    admission,
    evidence,
    validate,
    manifest,
    calls,
    leases,
    options,
    time(value: string) {
      now = value
    },
    revoke() {
      active = false
    },
    revokeChain() {
      chainActive = false
    },
    revokeAccess() {
      permitted = false
    },
    grantAccess() {
      permitted = true
    }
  }
}
