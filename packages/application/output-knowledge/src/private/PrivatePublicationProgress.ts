import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputPrivatePublicationRequestDigest,
  outputString,
  outputU32,
  outputU64,
  parseOutputChain,
  parseOutputJSON,
  parseOutputPrivatePublish,
  parseOutputPrivatePublicationResult,
  type OutputChain,
  type OutputJSONObject,
  type OutputPrivatePublicationResult
} from '@bsv/sdk'
import { parseOutputSTEAK } from '@bsv/sdk/overlay-tools/OutputObservation'
import { protectedDigest } from './ProtectedLedgerCodec.js'

type Admission = {
  operationId: string
  txid: string
  assessmentContextId: string
  steak: ReturnType<typeof parseOutputSTEAK>
}
type LookupBinding = {
  publicationId: string
  requestDigest: string
  blobKey: string
  service: string
  rulesDigest: string
  receiptDigest: string
}
interface Base {
  format: 'private-publication-progress/1'
  publicationId: string
  requestDigest: string
  blobKey: string
  chain: OutputChain
  publisher: string
  topic: string
  txid: string
  outputIndex: number
  lookup: { service: string; rulesDigest: string }
  stagedUntil: string
  updatedAt: string
}
type Progress =
  | { phase: 'staged' }
  | { phase: 'admitting'; operationId: string }
  | { phase: 'binding'; admission: Admission }
  | { phase: 'excluded'; admission: Admission; reason: string }
  | { phase: 'ready'; admission: Admission; binding: LookupBinding }
  | {
      phase: 'unavailable'
      admission: Admission
      binding: LookupBinding
      reason: string
    }
  | { phase: 'rejected' | 'expired'; reason: string }
export type PrivatePublicationProgress = Base & { progress: Progress }
const BASE_FIELDS = [
  'format',
  'publicationId',
  'requestDigest',
  'blobKey',
  'chain',
  'publisher',
  'topic',
  'txid',
  'outputIndex',
  'lookup',
  'stagedUntil',
  'updatedAt',
  'progress'
]

/** Pure internal transition contract; it does not prove authorization, Bitcoin validity or durable effects. */
export function createPrivatePublicationProgress(
  request: unknown,
  selected: {
    publisher: string
    chain: OutputChain
    blobKey: string
    lookup: Base['lookup']
  },
  now: string,
  stagedUntil: string,
  supportedExtensions: readonly string[] = []
): PrivatePublicationProgress {
  const publish = parseOutputPrivatePublish(request, supportedExtensions)
  const chain = parseOutputChain(selected.chain),
    publisher = outputIdentity(selected.publisher)
  outputAssert(
    outputU64(stagedUntil) > outputU64(now),
    'Publication staging deadline has elapsed',
    'expired'
  )
  return parsePrivatePublicationProgress({
    format: 'private-publication-progress/1',
    publicationId: outputPacketDigest('private-publication', {
      chain,
      publisher,
      topic: publish.topic,
      requestId: publish.requestId
    }),
    requestDigest: outputPrivatePublicationRequestDigest(publish, supportedExtensions),
    blobKey: selected.blobKey,
    chain,
    publisher,
    topic: publish.topic,
    txid: publish.evidence.txid,
    outputIndex: publish.evidence.outputIndex,
    lookup: selected.lookup,
    stagedUntil,
    updatedAt: now,
    progress: { phase: 'staged' }
  })
}
export function privatePublicationOperation(state: PrivatePublicationProgress): string {
  return protectedDigest(
    canonicalOutputJSON({
      format: 'private-publication-admission/1',
      publicationId: state.publicationId,
      requestDigest: state.requestDigest,
      chain: state.chain,
      publisher: state.publisher,
      topic: state.topic,
      txid: state.txid,
      outputIndex: state.outputIndex,
      blobKey: state.blobKey
    })
  )
}
function admission(value: unknown, state: Base, included = true): Admission {
  closedOutputObject(value, ['operationId', 'txid', 'assessmentContextId', 'steak'])
  const result = {
    operationId: outputHex32(value.operationId),
    txid: outputHex32(value.txid),
    assessmentContextId: outputString(value.assessmentContextId),
    steak: parseOutputSTEAK(value.steak)
  }
  outputAssert(
    result.operationId ===
      privatePublicationOperation({
        ...state,
        progress: { phase: 'staged' }
      }) &&
      result.txid === state.txid &&
      Object.hasOwn(result.steak, state.topic) &&
      result.steak[state.topic].outputsToAdmit.includes(state.outputIndex) === included,
    'Publication admission does not bind the original output',
    'conflict'
  )
  return result
}
function binding(value: unknown, state: Base): LookupBinding {
  closedOutputObject(value, [
    'publicationId',
    'requestDigest',
    'blobKey',
    'service',
    'rulesDigest',
    'receiptDigest'
  ])
  const result = {
    publicationId: outputHex32(value.publicationId),
    requestDigest: outputHex32(value.requestDigest),
    blobKey: outputHex32(value.blobKey),
    service: outputString(value.service),
    rulesDigest: outputHex32(value.rulesDigest),
    receiptDigest: outputHex32(value.receiptDigest)
  }
  outputAssert(
    result.publicationId === state.publicationId &&
      result.requestDigest === state.requestDigest &&
      result.blobKey === state.blobKey &&
      result.service === state.lookup.service &&
      result.rulesDigest === state.lookup.rulesDigest,
    'Publication lookup binding differs',
    'conflict'
  )
  return result
}
function progress(value: unknown, state: Base): Progress {
  outputAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Invalid publication progress'
  )
  const phase = (value as { phase?: unknown }).phase
  if (phase === 'staged') {
    closedOutputObject(value, ['phase'])
    return { phase }
  }
  if (phase === 'admitting') {
    closedOutputObject(value, ['phase', 'operationId'])
    outputAssert(
      value.operationId ===
        privatePublicationOperation({
          ...state,
          progress: { phase: 'staged' }
        }),
      'Publication operation differs',
      'conflict'
    )
    return { phase, operationId: outputHex32(value.operationId) }
  }
  if (phase === 'rejected' || phase === 'expired') {
    closedOutputObject(value, ['phase', 'reason'])
    return { phase, reason: outputString(value.reason) }
  }
  if (phase === 'binding') {
    closedOutputObject(value, ['phase', 'admission'])
    return { phase, admission: admission(value.admission, state) }
  }
  if (phase === 'excluded') {
    closedOutputObject(value, ['phase', 'admission', 'reason'])
    return {
      phase,
      admission: admission(value.admission, state, false),
      reason: outputString(value.reason)
    }
  }
  outputAssert(phase === 'ready' || phase === 'unavailable', 'Unknown publication progress')
  closedOutputObject(value, [
    'phase',
    'admission',
    'binding',
    ...(phase === 'unavailable' ? ['reason'] : [])
  ])
  const checked = {
    admission: admission(value.admission, state),
    binding: binding(value.binding, state)
  }
  return phase === 'ready'
    ? { phase, ...checked }
    : { phase, ...checked, reason: outputString(value.reason) }
}
export function parsePrivatePublicationProgress(input: unknown): PrivatePublicationProgress {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 65536 }))
  closedOutputObject(value, BASE_FIELDS)
  outputAssert(
    value.format === 'private-publication-progress/1',
    'Unsupported publication progress format',
    'unsupported'
  )
  closedOutputObject(value.lookup, ['service', 'rulesDigest'])
  const base: Base = {
    format: value.format,
    publicationId: outputHex32(value.publicationId),
    requestDigest: outputHex32(value.requestDigest),
    blobKey: outputHex32(value.blobKey),
    chain: parseOutputChain(value.chain),
    publisher: outputIdentity(value.publisher),
    topic: outputString(value.topic),
    txid: outputHex32(value.txid),
    outputIndex: outputU32(value.outputIndex),
    lookup: {
      service: outputString(value.lookup.service),
      rulesDigest: outputHex32(value.lookup.rulesDigest)
    },
    stagedUntil: outputU64(value.stagedUntil).toString(),
    updatedAt: outputU64(value.updatedAt).toString()
  }
  return { ...base, progress: progress(value.progress, base) }
}
export type PrivatePublicationEvent =
  | { kind: 'reserve-admission' }
  | { kind: 'admitted'; admission: Admission }
  | { kind: 'excluded'; admission: Admission; reason: string }
  | { kind: 'bound'; binding: LookupBinding }
  | { kind: 'rejected'; reason: string; noEffect: true }
  | { kind: 'expired'; reason: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'restored'; binding: LookupBinding }

type Transition = (
  state: PrivatePublicationProgress,
  event: OutputJSONObject,
  now: string
) => Progress
const transitions: Readonly<Record<string, Transition>> = {
  'reserve-admission': (state, owned, time) => {
    closedOutputObject(owned, ['kind'])
    outputAssert(state.progress.phase === 'staged', 'Publication is not staged', 'conflict')
    outputAssert(
      outputU64(time) < outputU64(state.stagedUntil),
      'Publication staging deadline has elapsed',
      'expired'
    )
    return {
      phase: 'admitting',
      operationId: privatePublicationOperation(state)
    }
  },
  admitted: (state, owned) => {
    closedOutputObject(owned, ['kind', 'admission'])
    outputAssert(
      state.progress.phase === 'admitting',
      'Publication has no reserved admission',
      'conflict'
    )
    return { phase: 'binding', admission: admission(owned.admission, state) }
  },
  excluded: (state, owned) => {
    closedOutputObject(owned, ['kind', 'admission', 'reason'])
    outputAssert(
      state.progress.phase === 'admitting',
      'Publication has no reserved admission',
      'conflict'
    )
    // Definitive selected-output exclusion retains the original public effect.
    // It never claims transaction-wide rollback or sets the noEffect flag.
    return {
      phase: 'excluded',
      admission: admission(owned.admission, state, false),
      reason: outputString(owned.reason)
    }
  },
  bound: (state, owned) => {
    closedOutputObject(owned, ['kind', 'binding'])
    outputAssert(
      state.progress.phase === 'binding',
      'Publication has no retained admission',
      'conflict'
    )
    return {
      phase: 'ready',
      admission: state.progress.admission,
      binding: binding(owned.binding, state)
    }
  },
  rejected: (state, owned) => {
    closedOutputObject(owned, ['kind', 'reason', 'noEffect'])
    outputAssert(
      (state.progress.phase === 'staged' || state.progress.phase === 'admitting') &&
        owned.noEffect === true,
      'Publication rejection requires a definitive no-effect decision',
      'conflict'
    )
    return { phase: 'rejected', reason: outputString(owned.reason) }
  },
  expired: (state, owned, time) => {
    closedOutputObject(owned, ['kind', 'reason'])
    outputAssert(
      state.progress.phase === 'staged' && outputU64(time) >= outputU64(state.stagedUntil),
      'Publication cannot expire after an uncertain external effect',
      'conflict'
    )
    return { phase: 'expired', reason: outputString(owned.reason) }
  },
  unavailable: (state, owned) => {
    closedOutputObject(owned, ['kind', 'reason'])
    outputAssert(state.progress.phase === 'ready', 'Publication is not ready', 'conflict')
    return {
      ...state.progress,
      phase: 'unavailable',
      reason: outputString(owned.reason)
    }
  },
  restored: (state, owned) => {
    closedOutputObject(owned, ['kind', 'binding'])
    outputAssert(
      state.progress.phase === 'unavailable',
      'Publication is not unavailable',
      'conflict'
    )
    return {
      phase: 'ready',
      admission: state.progress.admission,
      binding: binding(owned.binding, state)
    }
  }
}

/** The owner must CAS-commit the returned plan before effects or disclosure; events come from qualified installed ports. */
export function advancePrivatePublicationProgress(
  input: unknown,
  event: PrivatePublicationEvent,
  now: string
): PrivatePublicationProgress {
  const state = parsePrivatePublicationProgress(input)
  const time = outputU64(now) > outputU64(state.updatedAt) ? now : state.updatedAt
  const owned = parseOutputJSON(canonicalOutputJSON(event, { bytes: 65536 }))
  outputAssert(
    owned !== null && typeof owned === 'object' && !Array.isArray(owned),
    'Invalid publication event'
  )
  outputAssert(
    typeof owned.kind === 'string' && Object.hasOwn(transitions, owned.kind),
    'Unknown private publication event'
  )
  return parsePrivatePublicationProgress({
    ...state,
    updatedAt: time,
    progress: transitions[owned.kind](state, owned, time)
  })
}
export function privatePublicationResult(input: unknown): OutputPrivatePublicationResult {
  const state = parsePrivatePublicationProgress(input),
    phase = state.progress.phase
  return parseOutputPrivatePublicationResult({
    version: 1,
    publicationId: state.publicationId,
    txid: state.txid,
    updatedAt: state.updatedAt,
    status: publicationStatus(phase),
    ...('reason' in state.progress ? { reason: state.progress.reason } : {})
  })
}

function publicationStatus(phase: PrivatePublicationProgress['progress']['phase']) {
  if (['staged', 'admitting', 'binding'].includes(phase)) return 'pending' as const
  if (phase === 'excluded') return 'rejected' as const
  return phase
}
