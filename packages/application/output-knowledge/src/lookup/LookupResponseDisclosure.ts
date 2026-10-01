import { LookupProviderWork } from './LookupProviderWork.js'
import {
  closedOutputObject,
  outputHex32,
  outputIdentity,
  outputString,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputServiceError,
  parseOutputLookupBatch
} from '@bsv/sdk'
import type { LookupProviderCaller, LookupAuthorizationContext } from './LookupProviderService.js'
import type { LookupProviderContracts } from './LookupProviderContracts.js'
import type { LookupSessionStorage, LookupSessionAuthorization } from './LookupSessionStorage.js'
import type { LookupSessionSend } from './LookupSessionSend.js'
import { normalizeLookupDisclosureGuards } from './LookupSessionCodec.js'

export interface LookupResponseDisclosureOptions {
  /** Shared or dedicated physical work budget; cancellation retains its slot until settlement. */
  work?: LookupProviderWork
  sessions: LookupSessionStorage & LookupSessionSend
  contracts: LookupProviderContracts
  /** Same installed current authorization policy as the provider. Every writer participates in its durable guards. */
  authorize(
    context: LookupAuthorizationContext,
    signal: AbortSignal
  ): Promise<Omit<LookupSessionAuthorization, 'principal'>>
  /** Synchronous authorization of identifier-free close/error control responses only. */
  authorizeControl(principal: string | null): boolean
}
export interface BoundLookupResponse {
  /** This binding owns the already prepared response; bytes and principal are checked again. */
  enqueue(
    bytes: Uint8Array,
    authenticatedIdentity: string,
    enqueue: (bytes: Uint8Array) => undefined,
    signal: AbortSignal
  ): Promise<void>
}

/**
 * Optional native-send composition for authenticated lookup. The existing service
 * still prepares/serializes normally. This companion reauthorizes after signing,
 * then retains the native enqueue inside the store's actual shared writer gate.
 * Signing, external policy resolution and other I/O never run under that lock.
 */
export class LookupResponseDisclosure {
  private readonly options: LookupResponseDisclosureOptions
  private readonly work: LookupProviderWork
  constructor(options: LookupResponseDisclosureOptions) {
    if (
      options.sessions.responseEnqueue !== 'lookup-session-send/1' ||
      options.sessions.durability !== 'durable'
    )
      throw new OutputProtocolError(
        'unsupported',
        'Lookup disclosure requires a durable native-enqueue store'
      )
    if (
      typeof options.authorizeControl !== 'function' ||
      options.authorizeControl.constructor.name === 'AsyncFunction'
    )
      throw new OutputProtocolError('invalid', 'Lookup control authorization must be synchronous')
    this.options = { ...options }
    this.work = options.work ?? new LookupProviderWork()
  }

  bind(
    operation: 'open' | 'read',
    body: string,
    authenticated: LookupProviderCaller
  ): BoundLookupResponse {
    if (operation !== 'open' && operation !== 'read')
      throw new OutputProtocolError('invalid', 'Invalid lookup data operation')
    const who = this.caller(authenticated),
      expected = this.bytes(body)
    const batch = parseOutputLookupBatch(parseOutputJSON(expected))
    if (batch.scope.service !== this.options.contracts.recoveryTrust().service)
      throw new OutputProtocolError('context-changed', 'Lookup response service changed')
    return Object.freeze({
      enqueue: async (
        bytes: Uint8Array,
        identity: string,
        enqueue: (bytes: Uint8Array) => undefined,
        signal: AbortSignal
      ) =>
        this.work.run(who.principal, signal, async signal => {
          this.check(bytes, expected, identity, who, signal)
          const saved = await this.options.sessions.session(batch.session, who.principal)
          const selection = this.options.contracts.restore(saved.contract, who.capabilityDigest)
          if (
            selection.profile.authentication !== 'brc103' ||
            expected.length > selection.profile.maxResponseBytes
          )
            throw new OutputProtocolError('context-changed', 'Lookup native-send selection changed')
          const granted = await this.options.authorize(
            structuredClone({
              operation,
              stage: 'disclosure',
              principal: who.principal,
              open: saved.open,
              selection,
              scope: saved.first.scope
            }),
            signal
          )
          closedOutputObject(granted, ['access', 'guards'])
          const auth = {
            access: outputString(granted.access),
            guards: normalizeLookupDisclosureGuards(granted.guards)
          }
          await this.options.sessions.enqueueResponse(
            {
              reference: { kind: 'session', session: batch.session, principal: who.principal },
              bytes
            },
            (header, owned) => {
              this.check(owned, expected, identity, who, signal)
              if (
                !header ||
                header.principal !== who.principal ||
                header.access !== auth.access ||
                header.guards.length !== auth.guards.length ||
                header.guards.some(
                  original =>
                    !auth.guards.some(
                      current =>
                        current.id === original.id &&
                        current.revision === original.revision &&
                        current.failure === original.failure
                    )
                )
              )
                throw new OutputProtocolError(
                  'unauthorized',
                  'Lookup response authorization partition changed'
                )
              return true
            },
            enqueue
          )
        })
    })
  }

  control(body: string, authenticated: LookupProviderCaller): BoundLookupResponse {
    const who = this.caller(authenticated),
      expected = this.bytes(body)
    const packet = parseOutputJSON(expected)
    if (
      packet !== null &&
      typeof packet === 'object' &&
      !Array.isArray(packet) &&
      'error' in packet
    )
      parseOutputServiceError(packet)
    else {
      closedOutputObject(packet, ['version', 'closed'])
      if (packet.version !== 1 || packet.closed !== true)
        throw new OutputProtocolError('invalid', 'Invalid lookup control response')
    }
    return Object.freeze({
      enqueue: async (
        bytes: Uint8Array,
        identity: string,
        enqueue: (bytes: Uint8Array) => undefined,
        signal: AbortSignal
      ) =>
        this.work.run(who.principal, signal, async signal => {
          this.check(bytes, expected, identity, who, signal)
          await this.options.sessions.enqueueResponse(
            { reference: { kind: 'control' }, bytes },
            (_header, owned) => {
              this.check(owned, expected, identity, who, signal)
              return this.options.authorizeControl(who.principal) === true
            },
            enqueue
          )
        })
    })
  }

  private caller(input: LookupProviderCaller): LookupProviderCaller {
    closedOutputObject(input, ['principal', 'capabilityDigest'])
    if (input.principal === null)
      throw new OutputProtocolError(
        'unsupported',
        'Lookup native-send requires an authenticated principal'
      )
    return {
      principal: outputIdentity(input.principal),
      capabilityDigest: outputHex32(input.capabilityDigest)
    }
  }
  private bytes(body: string): Uint8Array {
    if (typeof body !== 'string' || body.length > 4194304)
      throw new OutputProtocolError('limited', 'Lookup response byte limit')
    parseOutputJSON(body)
    // The shared parser checks UTF-16 and the complete UTF-8 byte limit.
    return new TextEncoder().encode(body)
  }
  private check(
    bytes: Uint8Array,
    expected: Uint8Array,
    identity: string,
    who: LookupProviderCaller,
    signal: AbortSignal
  ): void {
    if (signal.aborted)
      throw new OutputProtocolError('cancelled', 'Lookup native enqueue cancelled')
    if (identity !== who.principal)
      throw new OutputProtocolError('unauthorized', 'Lookup response principal changed')
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length !== expected.length ||
      !bytes.every((byte, index) => byte === expected[index])
    )
      throw new OutputProtocolError('invalid', 'Lookup response bytes changed')
  }
}
