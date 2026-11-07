import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputLookupClose,
  parseOutputLookupOpen,
  parseOutputLookupRead,
  Random,
  Utils,
  type OutputCapabilitySelection,
  type OutputLookupBatch,
  type OutputLookupOpen,
  type OutputScope
} from '@bsv/sdk'
import { LookupBatchBuilder, type LookupBatchBoundary } from './LookupBatchBuilder.js'
import { LookupProviderContracts, lookupProviderMaximums } from './LookupProviderContracts.js'
import { LookupLiveReader, type LookupReadBudgets } from './LookupLiveReader.js'
import { LookupProviderWork, checkLookupWork } from './LookupProviderWork.js'
import { LookupWake } from './LookupWake.js'
import { lookupServingEpoch } from './LookupServingEpoch.js'
import { normalizeLookupDisclosureGuards, type LookupSessionOpening } from './LookupSessionCodec.js'
import type { LookupIndexStorage } from './LookupIndexStorage.js'
import type { LookupIndexFeed } from './LookupIndexFeed.js'
import type { LookupSessionAuthorization, LookupSessionStorage } from './LookupSessionStorage.js'

/** Transport-verified identity and the exact capability request header, never body authority. */
export interface LookupProviderCaller {
  principal: string | null
  capabilityDigest: string
}
export interface LookupAuthorizationContext {
  operation: 'open' | 'read' | 'close'
  stage: 'request' | 'disclosure'
  principal: string | null
  open: OutputLookupOpen
  selection: OutputCapabilitySelection
  /** Present for an existing session; authorization must preserve this access partition. */
  scope: OutputScope | null
}
export interface LookupProviderResponse {
  /** Already serialized behind the durable disclosure gate. Do not rehydrate or append rows. */
  body: string
  headers: OutputCapabilitySelection['headers']
}
export interface LookupProviderOptions {
  index: LookupIndexStorage
  sessions: LookupSessionStorage
  contracts: LookupProviderContracts
  now(): string
  /** Every external access/root/privacy writer participates in these durable guards. */
  authorize(
    context: LookupAuthorizationContext,
    signal: AbortSignal
  ): Promise<Omit<LookupSessionAuthorization, 'principal'>>
  work?: LookupProviderWork
  wake?: LookupWake
  budgets?: Partial<LookupReadBudgets>
}

/** Additive composition surface for domain-owned feeds without generic write authority. */
export interface LookupProviderFeedOptions extends Omit<LookupProviderOptions, 'index'> {
  index: LookupIndexFeed
}

const freshSecret = (): string => Utils.toHex(Random(32))
function caller(input: LookupProviderCaller): LookupProviderCaller {
  closedOutputObject(input, ['principal', 'capabilityDigest'])
  return {
    principal: input.principal === null ? null : outputIdentity(input.principal),
    capabilityDigest: outputHex32(input.capabilityDigest)
  }
}

/**
 * Durable progressive/live provider composition. HTTP authentication, byte limits,
 * response signing and admission projection are separate adapters. Neither a
 * legacy finite lookup nor an overlay propagation outbox supplies these promises.
 */
export class LookupProviderService {
  private readonly options: LookupProviderFeedOptions
  private readonly work: LookupProviderWork
  readonly wake: LookupWake
  private readonly reader: LookupLiveReader
  constructor(options: LookupProviderFeedOptions) {
    this.options = { ...options }
    if (options.index.durability !== 'durable' || options.sessions.durability !== 'durable')
      throw new OutputProtocolError(
        'unsupported',
        'Live lookup requires durable index and sessions'
      )
    this.work = options.work ?? new LookupProviderWork()
    this.wake = options.wake ?? new LookupWake(this.work.maximum)
    this.reader = new LookupLiveReader(options.index, this.wake, options.now, options.budgets)
  }

  async open(
    input: unknown,
    authenticated: LookupProviderCaller,
    signal?: AbortSignal
  ): Promise<LookupProviderResponse> {
    const who = caller(authenticated)
    return await this.work.run(who.principal, signal, async active => {
      const open = parseOutputLookupOpen(input)
      const saved = await this.options.sessions.recoverOriginal({
        principal: who.principal,
        open,
        manifestDigest: who.capabilityDigest
      })
      checkLookupWork(active)
      let opening: LookupSessionOpening
      if (saved !== null) {
        const selection = this.options.contracts.restore(saved.contract, who.capabilityDigest)
        this.requestBytes(open, selection)
        await this.authorize(
          'open',
          'request',
          who,
          saved.open,
          selection,
          saved.first.scope,
          active
        )
        opening = saved
      } else opening = await this.create(open, who, active)
      return await this.disclose('open', opening, opening.first, who, active)
    })
  }

  async read(
    input: unknown,
    authenticated: LookupProviderCaller,
    signal?: AbortSignal
  ): Promise<LookupProviderResponse> {
    const arrival = performance.now(),
      who = caller(authenticated)
    return await this.work.run(who.principal, signal, async active => {
      const read = parseOutputLookupRead(input)
      const opening = await this.options.sessions.session(read.session, who.principal)
      checkLookupWork(active)
      const selection = this.options.contracts.restore(opening.contract, who.capabilityDigest)
      this.requestBytes(read, selection)
      await this.authorize(
        'read',
        'request',
        who,
        opening.open,
        selection,
        opening.first.scope,
        active
      )
      const query = this.options.contracts.queries.prepare(
        opening.open,
        opening.first.scope,
        who.principal
      )
      const batch = await this.reader.read(
        this.boundary(opening),
        query,
        read.cursor,
        read.limits,
        lookupProviderMaximums(selection),
        arrival,
        active
      )
      return await this.disclose('read', opening, batch, who, active)
    })
  }

  async close(
    input: unknown,
    authenticated: LookupProviderCaller,
    signal?: AbortSignal
  ): Promise<LookupProviderResponse> {
    const who = caller(authenticated)
    return await this.work.run(who.principal, signal, async active => {
      const request = parseOutputLookupClose(input)
      let authorization: LookupSessionAuthorization | null = null
      try {
        const opening = await this.options.sessions.session(request.session, who.principal)
        const selection = this.options.contracts.restore(opening.contract, who.capabilityDigest)
        this.requestBytes(request, selection)
        authorization = await this.authorize(
          'close',
          'request',
          who,
          opening.open,
          selection,
          opening.first.scope,
          active
        )
      } catch (error) {
        if (
          !(error instanceof OutputProtocolError) ||
          !['unauthorized', 'reset-required', 'expired', 'context-changed', 'unsupported'].includes(
            error.code
          )
        )
          throw error
      }
      checkLookupWork(active)
      const result = await this.options.sessions.closeSession(request.session, authorization)
      checkLookupWork(active)
      this.wake.notify()
      return { body: canonicalOutputJSON(result), headers: this.headers(who) }
    })
  }

  private requestBytes(input: unknown, selection: OutputCapabilitySelection): void {
    canonicalOutputJSON(input, { bytes: Math.min(1048576, selection.profile.maxRequestBytes) })
  }

  private async create(
    open: OutputLookupOpen,
    who: LookupProviderCaller,
    signal: AbortSignal
  ): Promise<LookupSessionOpening> {
    const initial = this.options.contracts.fresh(who.capabilityDigest, this.options.now())
    this.requestBytes(open, initial.selection)
    if (
      open.service !== initial.selection.service.name ||
      (open.requiredRulesDigest !== undefined &&
        open.requiredRulesDigest !== initial.selection.service.rulesDigest)
    )
      throw new OutputProtocolError(
        'context-changed',
        'Lookup request changed its selected service or rules'
      )
    const auth = await this.authorize('open', 'request', who, open, initial.selection, null, signal)
    const time = outputU64(this.options.now()).toString()
    // Selection time is the actual timer/snapshot boundary, after authorization.
    const { record, selection } = this.options.contracts.fresh(who.capabilityDigest, time)
    const scope: OutputScope = {
      chain: selection.manifest.body.chain,
      provider:
        selection.profile.authentication === 'brc103'
          ? selection.manifest.body.identity
          : new URL(selection.manifest.body.baseURL).origin,
      service: selection.service.name,
      rulesDigest: selection.service.rulesDigest,
      queryDigest: outputPacketDigest('lookup-query', { service: open.service, query: open.query }),
      epoch: lookupServingEpoch(selection.manifest.body, selection.service.name),
      access: auth.access
    }
    const expiresAt = (
      outputU64(time) + outputU64(selection.profile.parameters.sessionSeconds)
    ).toString()
    const replayUntil = (
      outputU64(expiresAt) + outputU64(selection.profile.parameters.replaySeconds)
    ).toString()
    outputU64(replayUntil)
    const query = this.options.contracts.queries.prepare(open, scope, who.principal)
    const watermark = await this.reader.capture(time, signal)
    const boundary = {
      session: freshSecret(),
      secret: freshSecret(),
      scope,
      time,
      watermark,
      expiresAt,
      replayUntil
    }
    const first = await new LookupBatchBuilder(
      this.options.index,
      this.reader.budgets.maximumScans
    ).build(
      boundary,
      query,
      null,
      open.limits,
      lookupProviderMaximums(selection),
      watermark,
      signal
    )
    checkLookupWork(signal)
    const saved = await this.options.sessions.commit({
      principal: who.principal,
      open,
      contract: record,
      time,
      watermark,
      session: boundary.session,
      secret: boundary.secret,
      epoch: scope.epoch,
      access: auth.access,
      guards: auth.guards,
      first: first.batch
    })
    checkLookupWork(signal)
    return saved
  }

  private boundary(opening: LookupSessionOpening): LookupBatchBoundary {
    return {
      session: opening.session,
      secret: opening.secret,
      scope: opening.first.scope,
      watermark: opening.watermark,
      time: opening.time,
      expiresAt: opening.first.expiresAt,
      replayUntil: opening.first.replayUntil
    }
  }

  private async authorize(
    operation: LookupAuthorizationContext['operation'],
    stage: LookupAuthorizationContext['stage'],
    who: LookupProviderCaller,
    open: OutputLookupOpen,
    selection: OutputCapabilitySelection,
    scope: OutputScope | null,
    signal: AbortSignal
  ): Promise<LookupSessionAuthorization> {
    checkLookupWork(signal)
    if ((selection.profile.authentication === 'brc103') !== (who.principal !== null))
      throw new OutputProtocolError(
        'unauthorized',
        'Lookup caller does not match selected authentication'
      )
    const result = await this.options.authorize(
      structuredClone({ operation, stage, principal: who.principal, open, selection, scope }),
      signal
    )
    checkLookupWork(signal)
    closedOutputObject(result, ['access', 'guards'])
    const auth = {
      principal: who.principal,
      access: outputString(result.access),
      guards: normalizeLookupDisclosureGuards(result.guards)
    }
    if (scope !== null && auth.access !== scope.access)
      throw new OutputProtocolError('unauthorized', 'Lookup access partition changed')
    return auth
  }

  private async disclose(
    operation: 'open' | 'read',
    opening: LookupSessionOpening,
    batch: OutputLookupBatch,
    who: LookupProviderCaller,
    signal: AbortSignal
  ): Promise<LookupProviderResponse> {
    const selection = this.options.contracts.restore(opening.contract, who.capabilityDigest)
    const auth = await this.authorize(
      operation,
      'disclosure',
      who,
      opening.open,
      selection,
      opening.first.scope,
      signal
    )
    checkLookupWork(signal)
    const body = await this.options.sessions.serialize(opening.session, auth, batch)
    checkLookupWork(signal)
    return { body, headers: selection.headers }
  }

  private headers(who: LookupProviderCaller): OutputCapabilitySelection['headers'] {
    return {
      'x-bsv-overlay-capability': who.capabilityDigest,
      'x-bsv-overlay-profile': 'https://bsv.brc.dev/overlays/0193#lookup-live-v1'
    }
  }
}
