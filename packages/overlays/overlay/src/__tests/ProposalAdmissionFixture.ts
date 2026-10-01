import { OverlayProposalAdmission } from '../ProposalAdmission.js'
import type { Engine } from '../Engine.js'
import {
  Transaction,
  Utils,
  PrivateKey,
  OUTPUT_PROFILES,
  outputPacketDigest,
  signOutputPacket,
  selectOutputCapability,
  type OutputCapabilities,
  type OutputProposalBody
} from '@bsv/sdk'
import { type OverlayProposalAdmissionJob } from '../ProposalAdmission.js'
import {
  admissionSemanticDigest,
  type RetainedAdmission,
  type AdmissionHistoryResult,
  type StorageScope
} from '../storage/AdmissionStorage.js'
import { OVERLAY_ENGINE_POLICY_ID, overlayAdmissionContextDigest } from '../EngineAdmission.js'

// Public BRC-62 interoperability bytes; independent of the bridge implementation.
const BRC62Hex =
  '0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000'
export const transaction = Transaction.fromHexBEEF(BRC62Hex)
export const key = new PrivateKey(11)
export const identity = key.toPublicKey().toString()
export const chain = { network: 'test', genesisHash: '01'.repeat(32) }
export const scope: StorageScope = { ...chain, nodeId: 'local-node' }
export const topic = 'tm_records'
export const service = 'proposal-records'
export const rules = { id: 'urn:test:record-service', parameters: {} }
export const rulesDigest = outputPacketDigest('service-rules', rules)
const policy = { id: 'urn:test:proposal-policy', parameters: {} }
export const policyReference = {
  id: policy.id,
  digest: outputPacketDigest('proposal-policy', policy)
}
export function inputs() {
  const proposal = signOutputPacket<OutputProposalBody>(
    'proposal',
    {
      version: 1,
      service,
      chain,
      policy: policyReference,
      channel: '02'.repeat(32),
      revision: '0',
      previous: null,
      author: identity,
      recipients: [],
      anchors: [],
      issuedAt: '10',
      expiresAt: '100',
      operation: 'update',
      payload: ''
    },
    key
  )
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
              id: OUTPUT_PROFILES.proposal,
              authentication: 'brc103',
              payment: 'none',
              maxRequestBytes: 1048576,
              maxResponseBytes: 1048576,
              parameters: {
                policies: [{ ...policy, digest: policyReference.digest }],
                maxLifetimeSeconds: '100',
                retentionSeconds: '1000'
              }
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
    profile: OUTPUT_PROFILES.proposal,
    now: '20',
    maximumAgeSeconds: '100',
    clockSkewSeconds: '1',
    rules: new Map([[rules.id, () => {}]])
  })
  const job: OverlayProposalAdmissionJob = {
    caller: identity,
    operationId: 'proposal-finalize-1',
    txid: transaction.id('hex'),
    rawTransaction: Utils.toBase64(transaction.toBinary()),
    beef: Utils.toBase64(transaction.toBEEF()),
    requestedAt: '20'
  }
  return {
    proposal,
    selection,
    job,
    context: { id: 'original-reservation-context', view: { chain } }
  }
}
export function retained(): RetainedAdmission {
  const original = {
    scope: { ...scope },
    txid: transaction.id('hex'),
    mode: 'historical' as const,
    contextDigest: overlayAdmissionContextDigest(),
    topics: [
      { topic, policyId: OVERLAY_ENGINE_POLICY_ID },
      { topic: 'tm_private', policyId: 'private-policy' }
    ]
  }
  return {
    identity: original,
    receipt: {
      operationId: 'original-multi-topic-operation',
      semanticDigest: admissionSemanticDigest(original),
      durability: 'atomic-local',
      steak: JSON.stringify({
        [topic]: { outputsToAdmit: [0], coinsToRetain: [], coinsRemoved: [] },
        tm_private: { outputsToAdmit: [0], coinsToRetain: [] },
        tm_duplicate: { outputsToAdmit: [], coinsToRetain: [] }
      }),
      indexes: [{ target: 'private-index', state: 'pending' }],
      propagation: 'not-requested'
    }
  }
}

export function fixture(maximumOutcomeBytes?: number) {
  const read = jest
    .fn<Promise<AdmissionHistoryResult>, [unknown]>()
    .mockResolvedValue({ state: 'unresolved' })
  const submit = jest.fn().mockResolvedValue({ [topic]: { outputsToAdmit: [], coinsToRetain: [] } })
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
  const bridge = new OverlayProposalAdmission({
    engine,
    identity,
    rulesDigest,
    service,
    topic,
    maximumOutcomeBytes
  })
  return { ...inputs(), bridge, read, submit, engine }
}
