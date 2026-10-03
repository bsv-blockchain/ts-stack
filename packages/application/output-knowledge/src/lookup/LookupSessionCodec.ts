import {
  canonicalOutputJSON,
  closedOutputObject,
  negotiateOutputLookupLimits,
  OUTPUT_LOOKUP_PROFILE,
  outputHex32,
  outputIdentity,
  outputLookupCheckpoint,
  outputPacketDigest,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputLookupBatch,
  parseOutputLookupOpen,
  restoreOutputCapability,
  type OutputCapabilityRecoveryRequest,
  type OutputCapabilitySelection,
  type OutputLookupBatch,
  type OutputLookupCheckpoint,
  type OutputLookupLimits,
  type OutputLookupOpen,
  type OutputRetainedCapability
} from '@bsv/sdk'
import { LookupCursorCodec } from './LookupCursorCodec.js'
import { lookupServingEpoch } from './LookupServingEpoch.js'

export interface LookupDisclosureGuard {
  id: string
  revision: string
  /** Error after this retained authorization/serving premise changes. */
  failure: 'unauthorized' | 'reset-required'
}

/** Private durable opening record; never a remotely accepted request shape. */
export interface LookupSessionOpening {
  principal: string | null
  open: OutputLookupOpen
  contract: OutputRetainedCapability
  time: string
  watermark: string
  session: string
  secret: string
  access: string
  epoch: string
  first: OutputLookupBatch
  guards: LookupDisclosureGuard[]
}

/** Independent column bounds avoid constructing a combined, oversized JSON envelope. */
export interface LookupSessionColumns {
  metadata: string
  open: string
  contract: string
  first: string
}

/** Small private final-gate material, authenticated by the concrete durable store. */
export interface LookupSessionHeader extends Omit<
  LookupSessionOpening,
  'open' | 'contract' | 'first'
> {
  first: OutputLookupCheckpoint
  maximums: OutputLookupLimits
}

const maximumMetadataBytes = 65536

export function normalizeLookupDisclosureGuards(input: unknown): LookupDisclosureGuard[] {
  const owned = parseOutputJSON(canonicalOutputJSON(input, { bytes: maximumMetadataBytes }), {
    bytes: maximumMetadataBytes
  })
  if (!Array.isArray(owned) || owned.length === 0 || owned.length > 32)
    throw new OutputProtocolError('invalid', 'Lookup opening requires bounded disclosure guards')
  const result = owned.map((value): LookupDisclosureGuard => {
    closedOutputObject(value, ['id', 'revision', 'failure'])
    outputString(value.id)
    outputU64(value.revision)
    if (value.failure !== 'unauthorized' && value.failure !== 'reset-required')
      throw new OutputProtocolError('invalid', 'Invalid lookup disclosure guard')
    return {
      id: value.id as string,
      revision: value.revision as string,
      failure: value.failure
    }
  })
  if (new Set(result.map(value => value.id)).size !== result.length)
    throw new OutputProtocolError('invalid', 'Lookup opening repeats a disclosure guard')
  return result
}

/**
 * Validates local retained opening material against installed capability rules.
 * This is neither current authorization nor persistence. The provider must
 * atomically retain all columns, the original-operation fence and the history pin,
 * then recheck current disclosure guards immediately before serialization.
 */
export class LookupSessionCodec {
  private readonly trust: OutputCapabilityRecoveryRequest
  constructor(trust: OutputCapabilityRecoveryRequest) {
    if (trust.kind !== 'lookup' || trust.profile !== OUTPUT_LOOKUP_PROFILE)
      throw new OutputProtocolError('unsupported', 'Lookup session requires the live profile')
    if ((trust.supportedExtensions?.length ?? 0) !== 0)
      throw new OutputProtocolError(
        'unsupported',
        'Base lookup sessions implement no critical extensions'
      )
    this.trust = {
      ...trust,
      chain: { ...trust.chain },
      rules: new Map(trust.rules),
      supportedExtensions: []
    }
  }

  normalize(input: unknown): LookupSessionOpening {
    closedOutputObject(input, [
      'principal',
      'open',
      'contract',
      'time',
      'watermark',
      'session',
      'secret',
      'access',
      'epoch',
      'first',
      'guards'
    ])
    const principal = input.principal === null ? null : outputIdentity(input.principal)
    const open = parseOutputLookupOpen(input.open)
    const contract = parseOutputJSON(canonicalOutputJSON(input.contract, { bytes: 524288 }), {
      bytes: 524288
    }) as unknown as OutputRetainedCapability
    const selection = restoreOutputCapability(contract, this.trust)
    const time = outputU64(input.time).toString()
    const watermark = outputU64(input.watermark).toString()
    const session = outputHex32(input.session)
    const secret = outputHex32(input.secret)
    const access = outputString(input.access)
    const epoch = outputString(input.epoch)
    const first = parseOutputLookupBatch(input.first)
    const opening: LookupSessionOpening = {
      principal,
      open,
      contract,
      time,
      watermark,
      session,
      secret,
      access,
      epoch,
      first,
      guards: normalizeLookupDisclosureGuards(input.guards)
    }
    this.checkContract(opening, selection)
    this.checkFirst(opening, selection)
    return opening
  }

  private checkContract(value: LookupSessionOpening, selection: OutputCapabilitySelection): void {
    if (lookupServingEpoch(selection.manifest.body, selection.service.name) !== value.epoch)
      throw new OutputProtocolError(
        'reset-required',
        'Original lookup selector belongs to another storage epoch'
      )
    if (
      value.contract.selectedAt !== value.time ||
      value.open.service !== selection.service.name ||
      (value.open.requiredRulesDigest !== undefined &&
        value.open.requiredRulesDigest !== selection.service.rulesDigest)
    )
      throw new OutputProtocolError(
        'context-changed',
        'Lookup opening changed its original contract'
      )
    if ((selection.profile.authentication === 'brc103') !== (value.principal !== null))
      throw new OutputProtocolError(
        'unauthorized',
        'Lookup principal does not match the selected authentication mode'
      )
  }

  private checkFirst(value: LookupSessionOpening, selection: OutputCapabilitySelection): void {
    const { first, open, time, watermark, session, epoch, access } = value
    const { manifest, service, profile } = selection
    const scope = {
      chain: manifest.body.chain,
      provider:
        profile.authentication === 'brc103'
          ? manifest.body.identity
          : new URL(manifest.body.baseURL).origin,
      service: service.name,
      rulesDigest: service.rulesDigest,
      queryDigest: outputPacketDigest('lookup-query', { service: open.service, query: open.query }),
      epoch,
      access
    }
    const expiresAt = (outputU64(time) + outputU64(profile.parameters.sessionSeconds)).toString()
    const replayUntil = (
      outputU64(expiresAt) + outputU64(profile.parameters.replaySeconds)
    ).toString()
    outputU64(replayUntil)
    const limits = negotiateOutputLookupLimits(open.limits, {
      maxBytes: profile.maxResponseBytes,
      maxObservations: profile.parameters.maxObservations as number,
      waitMs: profile.parameters.maxWaitMs as number
    })
    if (
      first.session !== session ||
      first.phase !== 'snapshot' ||
      first.through !== watermark ||
      first.expiresAt !== expiresAt ||
      first.replayUntil !== replayUntil ||
      canonicalOutputJSON(first.scope) !== canonicalOutputJSON(scope) ||
      canonicalOutputJSON(first.limits) !== canonicalOutputJSON(limits)
    )
      throw new OutputProtocolError(
        'context-changed',
        'First lookup response changed its opening boundary'
      )
    const cursor = new LookupCursorCodec(value.secret, session, epoch).open(first.cursor)
    if (first.snapshotComplete) {
      if (cursor.phase !== 'live' || cursor.through !== watermark)
        throw new OutputProtocolError(
          'context-changed',
          'Completed snapshot lost its live cursor boundary'
        )
    } else if (
      cursor.phase !== 'snapshot' ||
      cursor.watermark !== watermark ||
      cursor.after === null
    ) {
      throw new OutputProtocolError('context-changed', 'Incomplete snapshot lost its scan position')
    }
  }

  encode(input: unknown): LookupSessionColumns {
    const value = this.normalize(input)
    const { open, contract, first, ...metadata } = value
    return {
      metadata: canonicalOutputJSON(
        { format: 'output-live-lookup-opening/1', ...metadata },
        { bytes: maximumMetadataBytes }
      ),
      open: canonicalOutputJSON(open, { bytes: 1048576 }),
      contract: canonicalOutputJSON(contract, { bytes: 524288 }),
      first: canonicalOutputJSON(first, { bytes: 4194304 })
    }
  }

  header(input: unknown): LookupSessionHeader {
    const value = this.normalize(input)
    const { profile } = restoreOutputCapability(value.contract, this.trust)
    const { open: _open, contract: _contract, first, ...metadata } = value
    return {
      ...metadata,
      first: outputLookupCheckpoint(first),
      maximums: {
        maxBytes: profile.maxResponseBytes,
        maxObservations: profile.parameters.maxObservations as number,
        waitMs: profile.parameters.maxWaitMs as number
      }
    }
  }

  decode(columns: LookupSessionColumns): LookupSessionOpening {
    const metadata = parseOutputJSON(columns.metadata, { bytes: maximumMetadataBytes })
    closedOutputObject(metadata, [
      'format',
      'principal',
      'time',
      'watermark',
      'session',
      'secret',
      'access',
      'epoch',
      'guards'
    ])
    if (metadata.format !== 'output-live-lookup-opening/1')
      throw new OutputProtocolError('unsupported', 'Unsupported retained lookup opening format')
    const { format: _format, ...fields } = metadata
    return this.normalize({
      ...fields,
      open: parseOutputJSON(columns.open, { bytes: 1048576 }),
      contract: parseOutputJSON(columns.contract, { bytes: 524288 }),
      first: parseOutputJSON(columns.first, { bytes: 4194304 })
    })
  }
}
