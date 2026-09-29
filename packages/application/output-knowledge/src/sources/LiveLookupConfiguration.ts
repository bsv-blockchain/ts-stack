import {
  canonicalOutputJSON,
  parseOutputJSON,
  parseOutputLookupOpen,
  retainOutputCapability,
  restoreOutputCapability,
  negotiateOutputLookupLimits,
  OUTPUT_LOOKUP_PROFILE,
  outputPacketDigest,
  outputString,
  outputU64,
  Random,
  Utils,
  OutputProtocolError,
  type OutputJSONObject,
  type OutputJSON,
  type OutputCapabilityRequest,
  type OutputCapabilityRecoveryRequest,
  type OutputCapabilitySelection,
  type OutputLookupLimits
} from '@bsv/sdk'
import { parseSourceRequest, runtimeLimits } from '../validation.js'
import type { OutputPartition, RuntimeLimits } from '../ports.js'
import { OperationStateCodec } from '../operations/OperationStateCodec.js'
import type { OperationStateLimits } from '../operations/OperationStateStore.js'
import { LookupSourceFraming, type LookupQueryScope } from './LookupSourceFraming.js'
import { LookupSourceStateCodec, type LookupSourceOriginal } from './LookupSourceState.js'

/** Reconstructible local binding; the original random Open lives in the saved value. */
export interface LiveLookupSourceConfiguration {
  id: string
  journalId: string
  partition: OutputPartition
  generation: string
  scope: LookupQueryScope
  limits?: Partial<RuntimeLimits>
  /** Minimum spacing of reads at the live head, including waitMs=0. Default 250 ms. */
  minimumPollMs?: number
  /** Total deadline for a control/receipt/network step. Default 30000 ms. */
  operationTimeoutMs?: number
}
export interface NormalizedLiveLookupConfiguration extends LiveLookupSourceConfiguration {
  limits: RuntimeLimits
  minimumPollMs: number
  operationTimeoutMs: number
}

export function normalizeLiveLookupConfiguration(
  input: LiveLookupSourceConfiguration
): NormalizedLiveLookupConfiguration {
  const request = parseSourceRequest({
    partition: input.partition,
    generation: input.generation,
    scope: { ...input.scope, access: 'unassigned', epoch: 'unassigned' },
    limits: runtimeLimits(input.limits)
  })
  const { access: _access, epoch: _epoch, ...scope } = request.scope
  const minimumPollMs = input.minimumPollMs ?? 250
  const operationTimeoutMs = input.operationTimeoutMs ?? 30000
  for (const value of [minimumPollMs, operationTimeoutMs])
    if (!Number.isSafeInteger(value) || value < 1 || value > 30000)
      throw new OutputProtocolError('invalid', 'Invalid live source timing bound')
  if (minimumPollMs >= operationTimeoutMs)
    throw new OutputProtocolError('invalid', 'Live source polling must fit its operation deadline')
  return {
    id: outputString(input.id),
    journalId: outputString(input.journalId),
    partition: request.partition,
    generation: request.generation,
    scope,
    limits: request.limits,
    minimumPollMs,
    operationTimeoutMs
  }
}

/** Recompute this from trusted application configuration when reopening a control cell. */
export function liveLookupSourceBinding(input: LiveLookupSourceConfiguration): OutputJSONObject {
  return parseOutputJSON(
    canonicalOutputJSON({
      profile: OUTPUT_LOOKUP_PROFILE,
      ...normalizeLiveLookupConfiguration(input)
    })
  ) as OutputJSONObject
}

function checkTrust(request: OutputCapabilityRecoveryRequest): void {
  if (request.kind !== 'lookup' || request.profile !== OUTPUT_LOOKUP_PROFILE)
    throw new OutputProtocolError('unsupported', 'Live source requires the BRC-193 lookup profile')
  if ((request.supportedExtensions?.length ?? 0) !== 0)
    throw new OutputProtocolError(
      'unsupported',
      'Base live source implements no critical extensions'
    )
}

function checkWait(
  configuration: NormalizedLiveLookupConfiguration,
  limits: OutputLookupLimits
): void {
  if (limits.waitMs + configuration.minimumPollMs >= configuration.operationTimeoutMs)
    throw new OutputProtocolError(
      'invalid',
      'Lookup wait and polling exceed the operation deadline'
    )
}

export function liveLookupFraming(
  configuration: NormalizedLiveLookupConfiguration,
  selection: OutputCapabilitySelection,
  query: OutputJSON
): LookupSourceFraming {
  const { manifest, service, profile } = selection
  const scope: LookupQueryScope = {
    chain: manifest.body.chain,
    provider:
      profile.authentication === 'brc103'
        ? manifest.body.identity
        : new URL(manifest.body.baseURL).origin,
    service: service.name,
    rulesDigest: service.rulesDigest,
    queryDigest: outputPacketDigest('lookup-query', { service: service.name, query })
  }
  if (canonicalOutputJSON(scope) !== canonicalOutputJSON(configuration.scope))
    throw new OutputProtocolError('context-changed', 'Selected lookup differs from local binding')
  return new LookupSourceFraming({
    ...configuration,
    scope,
    authentication: profile.authentication === 'brc103' ? 'brc103' : 'configured-transport'
  })
}

export interface PrepareLiveLookupSourceOptions {
  configuration: LiveLookupSourceConfiguration
  /** The application allocates and retains this local workflow identity. */
  namespace: string
  manifest: unknown
  selection: OutputCapabilityRequest
  query: OutputJSON
  limits: OutputLookupLimits
  minimumReceived: string
  controlLimits?: Partial<OperationStateLimits>
}

/**
 * Local initiation: validates a fresh capability, allocates a 256-bit Open ID and
 * reserves complete framing capacity. Atomically create the returned control
 * cell BEFORE invoking source.connect. On restart, OPEN that existing
 * cell using liveLookupSourceBinding; never prepare another uncertain operation.
 */
export function prepareLiveLookupSource(options: PrepareLiveLookupSourceOptions): {
  namespace: string
  binding: OutputJSONObject
  initial: OutputJSONObject
  limits: OperationStateLimits
} {
  checkTrust(options.selection)
  outputU64(options.minimumReceived)
  const configuration = normalizeLiveLookupConfiguration(options.configuration)
  const binding = liveLookupSourceBinding(configuration)
  const storage = new OperationStateCodec(options.namespace, binding, options.controlLimits)
  const { record, selection } = retainOutputCapability(options.manifest, options.selection)
  const framing = liveLookupFraming(configuration, selection, options.query)
  const limits = negotiateOutputLookupLimits(options.limits, {
    maxBytes: selection.profile.maxResponseBytes,
    maxObservations: selection.profile.parameters.maxObservations as number,
    waitMs: selection.profile.parameters.maxWaitMs as number
  })
  checkWait(configuration, limits)
  const open = parseOutputLookupOpen({
    version: 1,
    requestId: Utils.toHex(Random(32)),
    service: selection.service.name,
    query: options.query,
    requiredRulesDigest: selection.service.rulesDigest,
    limits
  })
  const original = { contract: record, open }
  const provisional = new LookupSourceStateCodec(original, framing, storage.limits.stateBytes)
  open.limits.maxBytes = provisional.maximumWireBytes()
  const codec = new LookupSourceStateCodec(original, framing, storage.limits.stateBytes)
  const initial = codec.value(codec.initial(options.minimumReceived))
  storage.initial(initial)
  return { namespace: storage.namespace, binding, initial, limits: { ...storage.limits } }
}

/** Revalidate local saved selection under installed endpoint, identity and rules. */
export function restoreLiveLookupSource(
  original: LookupSourceOriginal,
  configuration: NormalizedLiveLookupConfiguration,
  trust: OutputCapabilityRecoveryRequest,
  stateBytes: number
): LookupSourceStateCodec {
  checkTrust(trust)
  const selection = restoreOutputCapability(original.contract, trust)
  const open = parseOutputLookupOpen(original.open)
  checkWait(configuration, open.limits)
  const framing = liveLookupFraming(configuration, selection, open.query)
  const codec = new LookupSourceStateCodec(
    { contract: original.contract, open },
    framing,
    stateBytes
  )
  if (open.limits.maxBytes > codec.maximumWireBytes())
    throw new OutputProtocolError(
      'limited',
      'Saved lookup allowance exceeds local framing capacity'
    )
  return codec
}
