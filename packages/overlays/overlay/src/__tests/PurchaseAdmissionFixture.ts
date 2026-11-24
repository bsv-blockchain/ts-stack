import {
  OUTPUT_PROFILES,
  outputPacketDigest,
  retainOutputCapability,
  signOutputPacket,
  Utils,
  type OutputCapabilities,
  type OutputPurchasePrepare
} from '@bsv/sdk'
import { OverlayPurchaseAdmission, type OverlayPurchaseAdmissionJob } from '../PurchaseAdmission.js'
import {
  fixture as proposalFixture,
  retained,
  chain,
  topic,
  key,
  identity,
  rules,
  rulesDigest,
  transaction
} from './ProposalAdmissionFixture.js'
import { asStorageUint64 } from '../storage/AdmissionStorage.js'

/** Actual public BRC62 bytes and signed companion representations. Installed
 * domain/intent premises are controlled here; this is not a covenant purchase.
 */
export function purchaseAdmissionFixture(
  options: Partial<ConstructorParameters<typeof OverlayPurchaseAdmission>[0]> = {}
) {
  const f = proposalFixture(),
    baseURL = 'https://provider.example/api',
    domainProfile = 'urn:test:purchase-domain'
  const body: OutputCapabilities = {
    version: 1,
    identity,
    baseURL,
    chain,
    issuedAt: '10',
    expiresAt: '100',
    services: [
      {
        name: topic,
        kind: 'topic',
        rules,
        rulesDigest,
        profiles: [
          {
            id: OUTPUT_PROFILES.purchase,
            authentication: 'brc103',
            payment: 'covenant',
            maxRequestBytes: 1048576,
            maxResponseBytes: 1048576,
            parameters: {
              recoverySeconds: '86400',
              releasePolicies: [{ kind: 'local-admission' }],
              domainProfiles: [domainProfile]
            }
          }
        ]
      }
    ]
  }
  const capability = retainOutputCapability(signOutputPacket('capabilities', body, key), {
    baseURL,
    identity,
    chain,
    service: topic,
    kind: 'topic',
    profile: OUTPUT_PROFILES.purchase,
    now: '20',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '1',
    rules: new Map([[rules.id, () => {}]])
  }).record
  const request: OutputPurchasePrepare = {
    version: 1,
    requestId: 'original-purchase',
    topic,
    listing: { chain, txid: '11'.repeat(32), outputIndex: 0 },
    assetId: '22'.repeat(32),
    termsDigest: '33'.repeat(32),
    recipient: identity,
    request: 'AA=='
  }
  const terms = signOutputPacket(
    'purchase-terms',
    {
      version: 1,
      acquisitionId: outputPacketDigest('purchase', {
        chain,
        seller: identity,
        recipient: identity,
        topic,
        requestId: request.requestId
      }),
      requestDigest: outputPacketDigest('purchase-request', request),
      seller: identity,
      recipient: identity,
      topic,
      listing: request.listing,
      assetId: request.assetId,
      termsDigest: request.termsDigest,
      domainProfile,
      domainEvidence: { schema: 'urn:test:purchase-evidence', bytes: 'AA==' },
      releasePolicy: { kind: 'local-admission' },
      purchaseUntil: '100',
      recoveryUntil: '86500'
    },
    key
  )
  const job: OverlayPurchaseAdmissionJob = {
    operationId: '44'.repeat(32),
    original: {
      request,
      terms: terms as OverlayPurchaseAdmissionJob['original']['terms'],
      capability
    },
    candidate: {
      version: 1,
      acquisitionId: terms.body.acquisitionId,
      txid: transaction.id('hex'),
      beef: Utils.toBase64(transaction.toBEEF())
    }
  }
  const installation = {
    engine: f.engine,
    identity,
    topic,
    rulesDigest,
    baseURL,
    rules: new Map([[rules.id, () => {}]]),
    domainProfile,
    admittedOutputIndex: 0,
    ...options
  }
  const bridge = new OverlayPurchaseAdmission(installation)
  const context = { checkCurrent: jest.fn(() => {}) }
  const original = () => ({ ...retained(), acceptedAt: asStorageUint64('30') })
  return {
    ...f,
    bridge,
    context,
    job,
    original,
    installation,
    run: (signal = new AbortController().signal) => bridge.recover(job, signal, context)
  }
}
