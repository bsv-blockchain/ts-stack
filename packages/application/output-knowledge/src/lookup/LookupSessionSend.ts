import type { LookupSessionHeader } from './LookupSessionCodec.js'

/** Private host selector. The authenticated request, not remote body metadata, supplies principal. */
export type LookupSessionResponseReference =
  { kind: 'session'; session: string; principal: string | null } | { kind: 'control' }

/**
 * Optional post-signing native enqueue companion. Existing serialize() remains
 * unchanged. All session, index and disclosure writers share this gate. Current
 * external privacy writers must block the matching durable guard before changing
 * policy/data and release it only after completion. No callback may await, close,
 * reenter storage, or defer the enqueue. Signing and network work stay outside.
 */
export interface LookupSessionSend {
  readonly responseEnqueue: 'lookup-session-send/1'
  enqueueResponse(
    candidate: { reference: LookupSessionResponseReference; bytes: Uint8Array },
    /** Current, owned private header; undefined for control is never permission. */
    validate: (header: LookupSessionHeader | undefined, bytes: Uint8Array) => boolean,
    /** Actual synchronous native enqueue; an exception afterward cannot prove non-delivery. */
    enqueue: (bytes: Uint8Array) => undefined
  ): Promise<void>
}
