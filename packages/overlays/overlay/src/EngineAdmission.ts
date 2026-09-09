import { createHash } from 'node:crypto'
import type { STEAK, Transaction } from '@bsv/sdk'
import { extractMerkleProofMetadata } from './BASM.js'
import {
  admissionSemanticDigest,
  asStorageUint64,
  getAdmissionStorage,
  type AdmissionCommit,
  type AdmissionCommitResult,
  type AdmissionOutboxIntent,
  type AdmissionPayloadRef,
  type AdmissionReconcileResult,
  type AdmissionStorage,
  type AdmissionTopicDecision,
  type HistoryFence,
  type StorageScope
} from './storage/AdmissionStorage.js'
import type { Output } from './Output.js'
import type { LookupService } from './LookupService.js'

export const OVERLAY_ENGINE_POLICY_ID = 'overlay-engine-submit-v1'

export type OverlayAdmissionMode = 'live' | 'historical'

type TopicValidationLike = {
  topic: string
  isDupe: boolean
  previousCoins: number[]
  previousOutputs: Array<Output | null>
  admissibleOutputs: {
    outputsToAdmit: number[]
    coinsToRetain: number[]
    coinsRemoved?: number[]
  }
}

export interface OverlayAdmissionHost {
  admission: AdmissionStorage
  admissionScope: StorageScope
  publishAdmissionPayload?: (input: {
    kind: AdmissionPayloadRef['kind']
    bytes: Uint8Array
    txid?: string
  }) => Promise<AdmissionPayloadRef>
  enlistedIndexTargets?: () => readonly string[]
  getHistoryFence?: (topic: string) => Promise<HistoryFence>
}

export function getOverlayAdmissionHost(storage: unknown): OverlayAdmissionHost | undefined {
  const admission = getAdmissionStorage(storage)
  if (admission === undefined || typeof storage !== 'object' || storage === null) return undefined
  if (!('admissionScope' in storage)) return undefined
  const scope = (storage as { admissionScope?: StorageScope }).admissionScope
  if (
    scope === undefined ||
    typeof scope.network !== 'string' ||
    typeof scope.genesisHash !== 'string' ||
    typeof scope.nodeId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(scope.genesisHash)
  ) {
    return undefined
  }
  const host = storage as OverlayAdmissionHost
  return {
    admission,
    admissionScope: { ...scope },
    publishAdmissionPayload: host.publishAdmissionPayload,
    enlistedIndexTargets: host.enlistedIndexTargets,
    getHistoryFence: host.getHistoryFence
  }
}

export function overlayAdmissionContextDigest(offChainValues?: number[]): string {
  const hash = createHash('sha256')
  if (offChainValues !== undefined) hash.update(Buffer.from(offChainValues))
  return hash.digest('hex')
}

export function overlayAdmissionOperationId(
  mode: OverlayAdmissionMode,
  txid: string,
  topics: string[]
): string {
  const topicKey = [...topics].sort((a, b) => a.localeCompare(b, 'en')).join('\n')
  const raw = `submit:${mode}:${txid}:${topicKey}`
  if (Buffer.byteLength(raw, 'utf8') <= 512 && raw.isWellFormed()) return raw
  return `submit:${createHash('sha256').update(raw, 'utf8').digest('hex')}`
}

export function overlayAdmissionMode(
  mode: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv'
): OverlayAdmissionMode {
  return mode === 'current-tx' ? 'live' : 'historical'
}

async function localPayload(
  host: OverlayAdmissionHost,
  kind: AdmissionPayloadRef['kind'],
  bytes: Uint8Array,
  txid?: string
): Promise<AdmissionPayloadRef> {
  if (host.publishAdmissionPayload !== undefined) {
    return await host.publishAdmissionPayload({ kind, bytes, txid })
  }
  return {
    kind,
    digest: createHash('sha256').update(bytes).digest('hex'),
    byteLength: asStorageUint64(String(bytes.byteLength))
  }
}

export async function buildOverlayAdmissionPlan(input: {
  host: OverlayAdmissionHost
  tx: Transaction
  txid: string
  beef: number[]
  topics: string[]
  mode: OverlayAdmissionMode
  offChainValues?: number[]
  validations: TopicValidationLike[]
  failedTopics: Set<string>
  lookupServices: { [key: string]: LookupService }
  includePropagation: boolean
  applied?: {
    firstSeenHeight?: number
    blockHeight?: number
    blockHash?: string
    blockIndex?: number
    merkleRoot?: string
  }
}): Promise<AdmissionCommit> {
  const accepted = input.validations.filter(
    validation =>
      !input.failedTopics.has(validation.topic) &&
      (validation.isDupe ||
        validation.admissibleOutputs.outputsToAdmit.length > 0 ||
        validation.admissibleOutputs.coinsToRetain.length > 0 ||
        validation.previousCoins.length > 0)
  )
  const identityTopics = accepted.map(validation => ({
    topic: validation.topic,
    policyId: OVERLAY_ENGINE_POLICY_ID
  }))
  if (identityTopics.length === 0) throw new Error('Overlay admission plan has no topics')
  const identity = {
    scope: input.host.admissionScope,
    txid: input.txid,
    mode: input.mode,
    contextDigest: overlayAdmissionContextDigest(input.offChainValues),
    topics: identityTopics
  }
  const raw = await localPayload(
    input.host,
    'raw-transaction',
    Buffer.from(input.tx.toBinary()),
    input.txid
  )
  const payloads: AdmissionPayloadRef[] = [raw]
  let proof: AdmissionPayloadRef | undefined
  if (input.tx.merklePath !== undefined) {
    proof = await localPayload(
      input.host,
      'merkle-path',
      Buffer.from(input.tx.merklePath.toBinary())
    )
    payloads.push(proof)
  }
  const merkle = extractMerkleProofMetadata(input.txid, input.tx.merklePath)
  const decisions: AdmissionTopicDecision[] = []
  const steak: STEAK = {}
  for (const validation of input.validations) {
    steak[validation.topic] = {
      outputsToAdmit: validation.admissibleOutputs.outputsToAdmit,
      coinsToRetain: validation.admissibleOutputs.coinsToRetain,
      coinsRemoved: validation.admissibleOutputs.coinsRemoved ?? []
    }
  }
  for (const validation of accepted) {
    const { outputsConsumed, outputsToMarkStale } = classifyCoins(input.tx, validation)
    const fence =
      input.host.getHistoryFence === undefined
        ? { chainEpoch: asStorageUint64('0'), topicHistoryGeneration: asStorageUint64('0') }
        : await input.host.getHistoryFence(validation.topic)
    const outputs: AdmissionTopicDecision['outputs'] = []
    for (const outputIndex of validation.admissibleOutputs.outputsToAdmit) {
      const txOut = input.tx.outputs[outputIndex]
      if (typeof txOut?.satoshis !== 'number' || !Number.isSafeInteger(txOut.satoshis)) continue
      const scriptBytes = Buffer.from(txOut.lockingScript.toBinary())
      const script = await localPayload(input.host, 'locking-script', scriptBytes)
      payloads.push(script)
      outputs.push({
        txid: input.txid,
        outputIndex: asStorageUint64(String(outputIndex)),
        satoshis: asStorageUint64(String(txOut.satoshis)),
        score: asStorageUint64(String(Date.now())),
        script: { payload: script, offset: asStorageUint64('0'), byteLength: script.byteLength }
      })
    }
    const spends = validation.previousOutputs.flatMap(output =>
      output === null
        ? []
        : [
            {
              outpoint: { txid: output.txid, outputIndex: asStorageUint64(String(output.outputIndex)) },
              expectedVersion: '1',
              spender: input.txid
            }
          ]
    )
    decisions.push({
      topic: validation.topic,
      expectedHistory: fence,
      reads: [],
      spends,
      evictions: outputsToMarkStale.map(item => ({
        txid: item.txid,
        outputIndex: asStorageUint64(String(item.previousOutputIndex))
      })),
      outputs,
      edges: outputsConsumed.flatMap(source =>
        outputs.map(output => ({
          source: { txid: source.txid, outputIndex: asStorageUint64(String(source.outputIndex)) },
          consumer: { txid: output.txid, outputIndex: output.outputIndex }
        }))
      ),
      applied: appliedRecord(input, proof, merkle)
    })
    steak[validation.topic] = {
      outputsToAdmit: validation.admissibleOutputs.outputsToAdmit,
      coinsToRetain: validation.admissibleOutputs.coinsToRetain,
      coinsRemoved: outputsToMarkStale.map(item => item.inputIndex)
    }
  }
  const enlisted = new Set(input.host.enlistedIndexTargets?.() ?? [])
  const outbox: AdmissionOutboxIntent[] = Object.keys(input.lookupServices)
    .filter(target => !enlisted.has(target))
    .map(target => ({
      eventId: `${overlayAdmissionOperationId(input.mode, input.txid, input.topics)}:lookup:${target}`,
      kind: 'lookup' as const,
      target,
      payloads: [raw]
    }))
  if (input.includePropagation && input.mode === 'live') {
    outbox.push({
      eventId: `${overlayAdmissionOperationId(input.mode, input.txid, input.topics)}:propagate`,
      kind: 'propagation',
      target: 'ship',
      payloads: [raw]
    })
  }
  return {
    key: {
      scope: input.host.admissionScope,
      operationId: overlayAdmissionOperationId(input.mode, input.txid, input.topics),
      semanticDigest: admissionSemanticDigest(identity)
    },
    identity,
    payloads: uniquePayloads(payloads),
    decisions,
    outbox,
    steak: JSON.stringify(steak)
  }
}

export async function waitForAdmissionReceipt(
  admission: AdmissionStorage,
  plan: AdmissionCommit,
  rebuild: () => Promise<AdmissionCommit>
): Promise<AdmissionCommitResult & { state: 'committed' }> {
  let current = plan
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await admission.commitAdmission(current)
    if (result.state === 'committed') return result
    if (result.state === 'rejected') {
      if (result.code === 'read-conflict' && attempt < 7) {
        current = await rebuild()
        continue
      }
      throw new Error(`Overlay admission rejected: ${result.code}`)
    }
    const reconciled: AdmissionReconcileResult = await admission.reconcileAdmission(
      current.key,
      result.attemptId
    )
    if (reconciled.state === 'committed') return reconciled
    if (reconciled.state === 'aborted') {
      current = await rebuild()
      continue
    }
    if (reconciled.state === 'rejected') {
      throw new Error(`Overlay admission rejected: ${reconciled.code}`)
    }
  }
  throw new Error('Overlay admission commit is pending')
}

function appliedRecord(
  input: {
    txid: string
    applied?: {
      firstSeenHeight?: number
      blockHeight?: number
      blockHash?: string
      blockIndex?: number
      merkleRoot?: string
    }
  },
  proof: AdmissionPayloadRef | undefined,
  merkle: ReturnType<typeof extractMerkleProofMetadata>
): AdmissionTopicDecision['applied'] {
  const applied: AdmissionTopicDecision['applied'] = { txid: input.txid }
  const firstSeen = input.applied?.firstSeenHeight ?? merkle?.blockHeight
  if (firstSeen !== undefined) applied.firstSeenHeight = asStorageUint64(String(firstSeen))
  if (proof !== undefined) applied.proof = proof
  const blockHash = input.applied?.blockHash
  const height = input.applied?.blockHeight ?? merkle?.blockHeight
  const index = input.applied?.blockIndex ?? merkle?.blockIndex
  const merkleRoot = input.applied?.merkleRoot ?? merkle?.merkleRoot
  if (
    blockHash !== undefined &&
    height !== undefined &&
    index !== undefined &&
    merkleRoot !== undefined
  ) {
    applied.block = {
      height: asStorageUint64(String(height)),
      hash: blockHash,
      index: asStorageUint64(String(index)),
      merkleRoot
    }
  }
  return applied
}

function uniquePayloads(payloads: AdmissionPayloadRef[]): AdmissionPayloadRef[] {
  const seen = new Set<string>()
  const result: AdmissionPayloadRef[] = []
  for (const payload of payloads) {
    const key = `${payload.kind}:${payload.digest}:${payload.byteLength}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(payload)
  }
  return result
}

function classifyCoins(
  tx: Transaction,
  validation: TopicValidationLike
): {
  outputsConsumed: Array<{ txid: string; outputIndex: number }>
  outputsToMarkStale: Array<{ txid: string; previousOutputIndex: number; inputIndex: number }>
} {
  const outputsConsumed: Array<{ txid: string; outputIndex: number }> = []
  const outputsToMarkStale: Array<{
    txid: string
    previousOutputIndex: number
    inputIndex: number
  }> = []
  for (const inputIndex of validation.previousCoins) {
    const input = tx.inputs[inputIndex]
    const previousTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    if (typeof previousTXID !== 'string') continue
    if (validation.admissibleOutputs.coinsToRetain.includes(inputIndex)) {
      outputsConsumed.push({ txid: previousTXID, outputIndex: input.sourceOutputIndex })
    } else {
      outputsToMarkStale.push({
        txid: previousTXID,
        previousOutputIndex: input.sourceOutputIndex,
        inputIndex
      })
    }
  }
  return { outputsConsumed, outputsToMarkStale }
}
