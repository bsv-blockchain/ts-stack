import type { OutputLookupBatch, OutputLookupOpen } from '@bsv/sdk'
import type { LookupDisclosureGuard, LookupSessionOpening } from './LookupSessionCodec.js'

export interface LookupOriginalRequest {
  principal: string | null
  open: OutputLookupOpen
  manifestDigest: string
}
export interface LookupOpeningIdentity extends LookupOriginalRequest {
  epoch: string
}

/** Trusted authorizer result, never a caller-supplied HTTP authority object. */
export interface LookupSessionAuthorization {
  principal: string | null
  access: string
  guards: LookupDisclosureGuard[]
}

export interface LookupSessionCapacity {
  epochs: number
  guards: number
  fences: number
  sessions: number
  /** Includes retained closed sessions until their original replay deadline. */
  sessionsPerPrincipal: number
  /** Logical encoded column bytes; not a SQLite/WAL disk quota. */
  bytes: number
}

export interface LookupDisclosureState {
  revision: string
  blocked: boolean
  /** Last block/release operation; permits exact lost-ack retry, never remote authority. */
  operation: string | null
}

/**
 * A provider's private durable session port. Returned openings contain secrets and
 * are for local composition only. They are not permission to disclose a response.
 * Every response, including an original Open retry, passes serialize after fresh
 * authorization. All privacy, access and root-serving writers must advance the
 * corresponding guards in the same durable domain used by this port.
 */
export interface LookupSessionStorage {
  readonly durability: 'durable' | 'volatile'
  readonly capacity: Readonly<LookupSessionCapacity>
  /** Allocate a fresh epoch and atomically retire earlier epochs for new Opens. */
  createEpoch(): Promise<string>
  /** Existing promises and exact original retries survive retirement. */
  retireEpoch(epoch: string): Promise<void>
  /** Bounded collection only after retirement and every replay promise has ended. */
  collectEpoch(
    epoch: string,
    maximumFences: number
  ): Promise<{ removed: number; complete: boolean }>
  recover(identity: LookupOpeningIdentity): Promise<LookupSessionOpening | null>
  /** Recover by wire selector even after the host rotates its current manifest. */
  recoverOriginal(request: LookupOriginalRequest): Promise<LookupSessionOpening | null>
  /** Atomic original fence + complete opening + index history pin. */
  commit(opening: LookupSessionOpening): Promise<LookupSessionOpening>
  session(session: string, principal: string | null): Promise<LookupSessionOpening>
  /** Final durable gate and bounded serialization form one linearized operation. */
  serialize(
    session: string,
    authorization: LookupSessionAuthorization,
    batch: OutputLookupBatch
  ): Promise<string>
  closeSession(
    session: string,
    authorization: LookupSessionAuthorization | null
  ): Promise<{ version: 1; closed: true }>
  initializeGuard(id: string): Promise<string>
  guard(id: string): Promise<string>
  guardState(id: string): Promise<LookupDisclosureState>
  /** Pure continuity invalidation. External privacy changes use block/release. */
  advanceGuard(id: string, expected: string): Promise<string>
  /** Persist the block before changing external policy/data; all new and old gates stop. */
  blockGuard(id: string, expected: string, operation: string): Promise<string>
  /** Release only after the matching external operation is durably complete. */
  releaseGuard(id: string, expected: string, operation: string): Promise<string>
  /** Drops expired payload bytes; original keyed fences remain. */
  compact(maximumSessions: number): Promise<number>
}
