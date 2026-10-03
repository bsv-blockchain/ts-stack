import {
  OverlayPrivatePublicationAdmission,
  type OverlayPrivatePublicationContext,
  type OverlayPrivatePublicationAdmissionOptions
} from '../PrivatePublicationAdmission.js'
import {
  transaction,
  key,
  identity,
  chain,
  scope,
  topic,
  service,
  rules,
  rulesDigest,
  retained
} from './ProposalAdmissionFixture.js'
import {
  OUTPUT_PROFILES,
  Utils,
  outputPacketDigest,
  outputPrivatePublicationRequestDigest,
  signOutputPacket,
  selectOutputCapability,
  type OutputCapabilities
} from '@bsv/sdk'
import {
  admissionSemanticDigest,
  type AdmissionHistoryResult,
  type AdmissionHistoryQuery
} from '../storage/AdmissionStorage.js'
import { overlayAdmissionContextDigest } from '../EngineAdmission.js'
import type { Engine } from '../Engine.js'

export function privateAdmissionFixture(
  overrides: Partial<OverlayPrivatePublicationAdmissionOptions> = {},
  maximumPrivateBytes = 65536,
  maximumRequestBytes = 1048576
) {
  const request = {
    version: 1 as const,
    requestId: 'publication-request-0001',
    topic,
    evidence: {
      txid: transaction.id('hex'),
      outputIndex: 0,
      beef: Utils.toBase64(transaction.toBEEF())
    },
    assetId: '11'.repeat(32),
    schema: 'urn:test:private-material',
    privateValues: Utils.toBase64([1, 2, 3])
  }
  const requestDigest = outputPrivatePublicationRequestDigest(request)
  const job = {
    publisher: identity,
    operationId: '22'.repeat(32),
    publicationId: outputPacketDigest('private-publication', {
      chain,
      publisher: identity,
      topic,
      requestId: request.requestId
    }),
    requestDigest,
    rawTransaction: Utils.toBase64(transaction.toBinary()),
    request
  }
  const manifest = signOutputPacket<OutputCapabilities>(
    'capabilities',
    {
      version: 1,
      identity,
      baseURL: 'https://provider.example/api',
      chain,
      issuedAt: '10',
      expiresAt: '100',
      services: [
        {
          name: service,
          kind: 'topic',
          rules,
          rulesDigest,
          profiles: [
            {
              id: OUTPUT_PROFILES.publication,
              authentication: 'brc103',
              payment: 'none',
              maxRequestBytes: maximumRequestBytes,
              maxResponseBytes: 65536,
              parameters: { schemas: [request.schema], maxPrivateBytes: maximumPrivateBytes }
            }
          ]
        }
      ]
    },
    key
  )
  const selection = selectOutputCapability(manifest, {
    baseURL: manifest.body.baseURL,
    identity,
    chain,
    kind: 'topic',
    service,
    profile: OUTPUT_PROFILES.publication,
    now: '20',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '1',
    rules: new Map([[rules.id, () => {}]])
  })
  const context = {
    id: 'verified-publication-context',
    publisher: identity,
    requestDigest,
    view: { chain: { ...chain } }
  }
  const read = jest
    .fn<Promise<AdmissionHistoryResult>, [AdmissionHistoryQuery]>()
    .mockResolvedValue({ state: 'unresolved' })
  const submit = jest.fn<ReturnType<Engine['submit']>, Parameters<Engine['submit']>>(async () => ({
    [topic]: { outputsToAdmit: [], coinsToRetain: [] }
  }))
  const engine = {
    storage: {
      admissionScope: { ...scope },
      admission: {
        protocol: 'overlay-admission-v1',
        commitAdmission() {},
        reconcileAdmission() {},
        history: { protocol: 'overlay-admission-history-v1', read }
      }
    },
    managers: { [topic]: {} },
    submit
  } as unknown as Engine
  const current = jest.fn<boolean, [OverlayPrivatePublicationContext]>(() => true)
  const options: OverlayPrivatePublicationAdmissionOptions = {
    engine,
    identity,
    service,
    topic,
    rulesDigest,
    isCurrent: current,
    publicAdmissionReuse: 'disabled',
    ...overrides
  }
  const bridge = new OverlayPrivatePublicationAdmission(options)
  const original = (kind: 'private' | 'public' = 'private') => {
    const value = retained()
    value.identity.contextDigest = overlayAdmissionContextDigest(
      kind === 'private' ? [1, 2, 3] : undefined
    )
    value.receipt.semanticDigest = admissionSemanticDigest(value.identity)
    return value
  }
  return {
    bridge,
    job,
    selection,
    context,
    read,
    submit,
    engine,
    current,
    options,
    original,
    run: () => bridge.recover(job, selection, context)
  }
}
